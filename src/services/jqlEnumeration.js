'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../db');

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
 * @param {string} cloudId
 * @param {import('axios').AxiosInstance} jiraAxios  Shared instance with 401 interceptor
 * @param {string} jql
 * @param {number} startAt
 * @returns {Promise<{issues: object[], total: number, startAt: number, maxResults: number}>}
 */
async function fetchIssuePage(cloudId, jiraAxios, jql, startAt) {
  const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/search`;
  const response = await jiraAxios.get(url, {
    params: { jql, startAt, maxResults: PAGE_SIZE },
  });
  return response.data;
}

/**
 * Paginate through all issues matching the JQL and upsert JiraIssueNodes.
 * Returns all issues collected.
 * @param {string} integrationId
 * @param {string} cloudId
 * @param {import('axios').AxiosInstance} jiraAxios
 * @param {string} jql
 * @returns {Promise<object[]>}
 */
async function paginateAllIssues(integrationId, cloudId, jiraAxios, jql) {
  const allIssues = [];
  let startAt = 0;

  while (true) {
    const page = await fetchIssuePage(cloudId, jiraAxios, jql, startAt);
    const { issues = [], total, maxResults } = page;

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
 * @returns {Promise<{issues: object[], runState: object, mode: string}>}
 */
async function runJqlEnumeration(integrationId, cloudId, projectKey, jiraAxios) {
  const runState = getOrCreateRunState(integrationId, cloudId, projectKey);
  const mode = runState.lastBackupTimestamp ? 'incremental' : 'full';

  runState.lastRunStatus = 'in_progress';
  db.backupRunStates.set(runState.id, runState);

  const runStartTime = new Date().toISOString();
  const jql = buildJql(projectKey, runState.lastBackupTimestamp);

  let issues;
  try {
    issues = await paginateAllIssues(integrationId, cloudId, jiraAxios, jql);
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
