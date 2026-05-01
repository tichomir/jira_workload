'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { PHASES, emitProgress } = require('./jobProgress');
// Lazy require to break the potential module-load cycle with tokenService
// (tokenService → db; jqlEnumeration → tokenService is fine; no cycle).
let _verifyAndRefreshCloudId = null;
function getVerifyCloudId() {
  if (!_verifyAndRefreshCloudId) {
    _verifyAndRefreshCloudId = require('./tokenService').verifyAndRefreshCloudId;
  }
  return _verifyAndRefreshCloudId;
}

const JIRA_API_BASE = 'https://api.atlassian.com/ex/jira';
const PAGE_SIZE = 100;
// 60-second overlap buffer guards against clock skew between backup service and Jira Cloud
const OVERLAP_BUFFER_MS = 60 * 1000;

/**
 * Format an ISO 8601 timestamp to Jira JQL date format: "YYYY-MM-DD HH:mm"
 * @param {string} isoString
 * @returns {string}
 */
function formatJqlTimestamp(isoString) {
  const d = new Date(isoString);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

/**
 * Build the JQL string for a backup run.
 * @param {string} projectKey
 * @param {string|null} lastBackupTimestamp  ISO 8601 or null (full run)
 * @returns {string}
 */
function buildJql(projectKey, lastBackupTimestamp) {
  if (!lastBackupTimestamp) {
    return `project="${projectKey}" ORDER BY updated ASC`;
  }
  // Apply 60-second overlap buffer
  const buffered = new Date(new Date(lastBackupTimestamp).getTime() - OVERLAP_BUFFER_MS);
  const jqlTs = formatJqlTimestamp(buffered.toISOString());
  return `project="${projectKey}" AND updated>="${jqlTs}" ORDER BY updated ASC`;
}

/**
 * Fetch a single page of issues from the Jira search API.
 * On a 410 Gone response, forces cloudId re-resolution via verifyAndRefreshCloudId and
 * retries the request once with the fresh cloudId URL.
 *
 * @param {string} cloudId
 * @param {import('axios').AxiosInstance} jiraAxios  Shared instance with 401 interceptor
 * @param {string} jql
 * @param {number} startAt
 * @param {string} [connectionId]  Optional — enables the 410 re-resolution retry path
 * @returns {Promise<{issues: object[], total: number, startAt: number, maxResults: number}>}
 */
async function fetchIssuePage(cloudId, jiraAxios, jql, startAt, connectionId) {
  const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/search/jql`;
  let response;
  try {
    response = await jiraAxios.get(url, {
      params: { jql, startAt, maxResults: PAGE_SIZE },
    });
  } catch (err) {
    // 410 Gone: the cloudId URL may be stale. Force re-resolution once and retry.
    if (err.response && err.response.status === 410 && connectionId) {
      const conn = db.connections.get(connectionId);
      if (conn) {
        // Clear the freshness gate so verifyAndRefreshCloudId always calls accessible-resources.
        conn.cloudIdVerifiedAt = null;
        db.connections.set(connectionId, conn);
      }
      const freshCloudId = await getVerifyCloudId()(connectionId);
      const retryUrl = `${JIRA_API_BASE}/${freshCloudId}/rest/api/3/search/jql`;
      response = await jiraAxios.get(retryUrl, {
        params: { jql, startAt, maxResults: PAGE_SIZE },
      });
      return response.data;
    }
    throw err;
  }
  return response.data;
}

/**
 * Paginate through all issues matching the JQL and upsert JiraIssueNodes.
 * Returns all issues collected.
 * @param {string} integrationId
 * @param {string} cloudId
 * @param {import('axios').AxiosInstance} jiraAxios
 * @param {string} jql
 * @param {string|null} [jobId]  Optional — emit per-page progress when provided
 * @param {string|null} [projectKey]  Optional — used as objectKey in progress events
 * @returns {Promise<object[]>}
 */
async function paginateAllIssues(integrationId, cloudId, jiraAxios, jql, jobId = null, projectKey = null) {
  const allIssues = [];
  let startAt = 0;

  while (true) {
    console.info(`[jql] fetching page: integrationId=${integrationId} startAt=${startAt} jql="${jql.substring(0, 80)}"`);
    const page = await fetchIssuePage(cloudId, jiraAxios, jql, startAt, integrationId);
    const { issues = [], total, maxResults } = page;
    console.info(`[jql] page received: issues=${issues.length} total=${total} startAt=${startAt}`);

    for (const issue of issues) {
      const nodeKey = `${integrationId}:${issue.key}`;
      db.issueNodes.set(nodeKey, {
        integrationId,
        cloudId,
        issueKey: issue.key,
        issueId: issue.id,
        summary: issue.fields && issue.fields.summary,
        status: issue.fields && issue.fields.status,
        statusCategory: issue.fields && issue.fields.status &&
          issue.fields.status.statusCategory && issue.fields.status.statusCategory.key,
        attachments: (issue.fields && issue.fields.attachment) || [],
        raw: issue,
        upsertedAt: new Date().toISOString(),
      });
    }

    allIssues.push(...issues);
    startAt += maxResults || PAGE_SIZE;

    // Emit progress after each page so the polling endpoint reflects live state.
    emitProgress(jobId, {
      phase: PHASES.ISSUE_FETCH,
      objectType: 'JiraIssueNode',
      objectKey: projectKey,
      processed: allIssues.length,
      total: total || allIssues.length,
    });

    if (startAt >= total || issues.length === 0) {
      break;
    }
  }

  return allIssues;
}

/**
 * Get or create a BackupRunState for a project.
 * @param {string} integrationId
 * @param {string} cloudId
 * @param {string} projectKey
 * @returns {object}
 */
function getOrCreateRunState(integrationId, cloudId, projectKey) {
  for (const state of db.backupRunStates.values()) {
    if (
      state.integrationId === integrationId &&
      state.cloudId === cloudId &&
      state.projectKey === projectKey
    ) {
      return state;
    }
  }
  const newState = {
    id: uuidv4(),
    integrationId,
    cloudId,
    projectKey,
    lastBackupTimestamp: null,
    lastRunStatus: null,
    lastRunCompletedAt: null,
  };
  db.backupRunStates.set(newState.id, newState);
  return newState;
}

/**
 * Run the JQL enumeration (full or incremental) for a single project.
 * Updates lastBackupTimestamp on success.
 * @param {string} integrationId
 * @param {string} cloudId
 * @param {string} projectKey
 * @param {import('axios').AxiosInstance} jiraAxios  Shared instance with 401 interceptor
 * @param {string|null} [jobId]  Optional — for per-page progress tracking
 * @returns {Promise<{issues: object[], runState: object, mode: string}>}
 */
async function runJqlEnumeration(integrationId, cloudId, projectKey, jiraAxios, jobId = null) {
  const runState = getOrCreateRunState(integrationId, cloudId, projectKey);
  const mode = runState.lastBackupTimestamp ? 'incremental' : 'full';

  runState.lastRunStatus = 'in_progress';
  db.backupRunStates.set(runState.id, runState);

  const runStartTime = new Date().toISOString();
  const jql = buildJql(projectKey, runState.lastBackupTimestamp);

  let issues;
  try {
    issues = await paginateAllIssues(integrationId, cloudId, jiraAxios, jql, jobId, projectKey);
  } catch (err) {
    runState.lastRunStatus = 'failed';
    db.backupRunStates.set(runState.id, runState);
    throw err;
  }

  // Only commit lastBackupTimestamp on full success
  runState.lastBackupTimestamp = runStartTime;
  runState.lastRunStatus = 'success';
  runState.lastRunCompletedAt = new Date().toISOString();
  db.backupRunStates.set(runState.id, runState);

  return { issues, runState, mode };
}

module.exports = {
  formatJqlTimestamp,
  buildJql,
  fetchIssuePage,
  paginateAllIssues,
  getOrCreateRunState,
  runJqlEnumeration,
};
