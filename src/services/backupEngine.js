'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { getValidAccessToken, createJiraAxiosInstance, verifyAndRefreshCloudId } = require('./tokenService');
const { PHASES, emitProgress } = require('./jobProgress');

const JIRA_API_BASE = 'https://api.atlassian.com/ex/jira';
const { runJqlEnumeration } = require('./jqlEnumeration');
const { ensureWebhookRegistered, buildWebhookJqlFilter } = require('./webhookRegistration');
const { processAttachments } = require('./attachmentMaterialisation');
const { runSiteEnumeration } = require('./siteObjectEnumeration');
const { tagIssueNodes } = require('./archiveScope');
const { saveManifest, computeContentHash } = require('./objectExplorerService');

/**
 * Run a full backup for a single project within an integration.
 * Orchestrates: JQL enumeration → attachment materialisation → archive scope tagging.
 *
 * @param {string} integrationId
 * @param {string} cloudId
 * @param {string} projectKey
 * @param {import('axios').AxiosInstance} jiraAxios  Shared Axios instance with 401 interceptor
 * @param {string|null} [jobId]  Optional — for progress tracking
 * @returns {Promise<{issues: object[], mode: string, runState: object, attachmentEntries: object[]}>}
 */
async function runProjectBackup(integrationId, cloudId, projectKey, jiraAxios, jobId = null) {
  const backupPointId = uuidv4();

  // JQL enumeration (full or incremental)
  const { issues, runState, mode } = await runJqlEnumeration(
    integrationId,
    cloudId,
    projectKey,
    jiraAxios,
    jobId
  );

  // Attachment materialisation
  emitProgress(jobId, { phase: PHASES.ATTACHMENT_DOWNLOAD, objectType: 'JiraAttachment', objectKey: projectKey, processed: 0, total: 0 });
  const attachmentEntries = await processAttachments(
    integrationId,
    backupPointId,
    issues,
    cloudId,
    jiraAxios,
    jobId
  );

  // Archive scope attribute tagging
  tagIssueNodes(integrationId, issues);

  return { issues, mode, runState, attachmentEntries, backupPointId };
}

/**
 * Run a full integration backup:
 * 1. Proactively refresh OAuth token if expiring within 5 minutes.
 * 2. Create a shared Axios instance with a 401-retry interceptor.
 * 3. Ensure webhook registered (idempotent).
 * 4. For each project in scope: run project backup.
 * 5. Run site-level enumeration (workflows, custom fields, contexts).
 *
 * @param {string} integrationId
 * @param {string} [jobId]  Optional — when provided, updates db.backupJobs with current phase
 * @returns {Promise<object>}
 */
async function runIntegrationBackup(integrationId, jobId) {
  // Initialise progress snapshot immediately so the endpoint returns data from the first poll.
  emitProgress(jobId, { phase: PHASES.INIT, processed: 0, total: 0, apiCallCount: 0, errorCount: 0 });

  // Helper: update both the job record's phase and the progress snapshot.
  function updatePhase(phase) {
    if (!jobId) return;
    const job = db.backupJobs.get(jobId);
    if (job) {
      job.phase = phase;
      db.backupJobs.set(jobId, job);
    }
    emitProgress(jobId, { phase });
  }

  const connection = db.connections.get(integrationId);
  if (!connection) {
    throw new Error(`Connection not found: ${integrationId}`);
  }

  console.info(`[backup] starting: integrationId=${integrationId} jobId=${jobId || 'n/a'}`);

  // CloudId freshness check: verify against Atlassian accessible-resources if not checked
  // within the last 24 hours. This catches stale cloudIds (e.g. after site migration) before
  // they cause mid-backup failures. The call is skipped when cloudIdVerifiedAt is recent.
  updatePhase(PHASES.INIT);
  console.info(`[backup] phase=verifying_cloud_id integrationId=${integrationId}`);
  const cloudId = await verifyAndRefreshCloudId(integrationId);

  // Proactive token check: refresh if expiring within 5 minutes.
  // createJiraAxiosInstance uses the fresh token and attaches a 401 interceptor
  // that will transparently refresh and retry if the token expires mid-run.
  // Pass jobId so the request interceptor tracks outbound API calls.
  console.info(`[backup] phase=refreshing_token integrationId=${integrationId}`);
  const accessToken = await getValidAccessToken(integrationId);
  const jiraAxios = createJiraAxiosInstance(integrationId, accessToken, jobId);

  // 1. Ensure webhook is registered (requires manage:jira-webhook scope)
  console.info(`[backup] phase=webhook_registration integrationId=${integrationId}`);
  const hasWebhookScope = connection.grantedScopes &&
    connection.grantedScopes.includes('manage:jira-webhook');

  let webhookResult = null;
  if (hasWebhookScope) {
    const jqlFilter = buildWebhookJqlFilter(connection);
    webhookResult = await ensureWebhookRegistered(integrationId, cloudId, accessToken, jqlFilter);
  }

  // 2. Determine project keys to back up
  updatePhase(PHASES.PROJECT_DISCOVERY);
  console.info(`[backup] phase=enumerating_projects integrationId=${integrationId}`);
  let projectKeys = [];
  if (connection.projectScopeMode === 'selected' && connection.selectedProjectIds && connection.selectedProjectIds.length > 0) {
    projectKeys = connection.selectedProjectIds;
  } else {
    // All projects mode — enumerate from Jira API, fall back to cached nodes.
    try {
      const projectSearchUrl = `${JIRA_API_BASE}/${cloudId}/rest/api/3/project/search`;
      let startAt = 0;
      while (true) {
        const resp = await jiraAxios.get(projectSearchUrl, {
          params: { startAt, maxResults: 50 },
        });
        const { values = [], isLast } = resp.data;
        for (const p of values) {
          if (p.key && !projectKeys.includes(p.key)) {
            projectKeys.push(p.key);
          }
          const nodeKey = `${integrationId}:${p.key}`;
          db.projectNodes.set(nodeKey, {
            integrationId,
            cloudId,
            projectKey: p.key,
            key: p.key,
            name: p.name,
            id: p.id,
            projectTypeKey: p.projectTypeKey,
            archived: p.archived || false,
          });
        }
        startAt += values.length || 50;
        if (isLast || values.length === 0) break;
      }
      console.info(`[backup] Enumerated ${projectKeys.length} project(s) from Jira API for integration ${integrationId}`);
    } catch (err) {
      console.warn(`[backup] Could not enumerate projects from Jira API (${err.message}); falling back to cached project nodes`);
      projectKeys = [...db.projectNodes.values()]
        .filter((p) => p.integrationId === integrationId)
        .map((p) => p.projectKey || p.key)
        .filter(Boolean);
    }
  }

  emitProgress(jobId, { objectType: 'JiraProjectNode', total: projectKeys.length, processed: 0 });

  // 3. Run per-project backup
  const projectResults = [];
  for (const projectKey of projectKeys) {
    updatePhase(PHASES.ISSUE_FETCH);
    console.info(`[backup] phase=backup_project integrationId=${integrationId} projectKey=${projectKey}`);
    emitProgress(jobId, { phase: PHASES.ISSUE_FETCH, objectType: 'JiraProjectNode', objectKey: projectKey });
    const result = await runProjectBackup(integrationId, cloudId, projectKey, jiraAxios, jobId);
    projectResults.push({ projectKey, ...result });
    emitProgress(jobId, { processed: projectResults.length, total: projectKeys.length });
  }

  // 4. Site-level enumeration (runs regardless of project scope)
  updatePhase(PHASES.WORKFLOW_ENUM);
  console.info(`[backup] phase=site_enumeration integrationId=${integrationId}`);
  const siteEnumResult = await runSiteEnumeration(cloudId, jiraAxios, jobId);

  // Update lastSyncedAt on connection
  const now = new Date().toISOString();
  connection.lastSyncedAt = now;
  connection.updatedAt = now;
  db.connections.set(integrationId, connection);

  // Determine priorBackupPointId for this integration
  const priorPoint = [...db.backupPoints.values()]
    .filter(bp => bp.integrationId === integrationId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

  const backupPointId = uuidv4();
  const totalIssues = projectResults.reduce((sum, pr) => sum + (pr.issues ? pr.issues.length : 0), 0);
  const totalAttachments = projectResults.reduce((sum, pr) => sum + (pr.attachmentEntries ? pr.attachmentEntries.length : 0), 0);

  const backupPoint = {
    id: backupPointId,
    integrationId,
    createdAt: now,
    priorBackupPointId: priorPoint ? priorPoint.id : null,
    status: 'completed',
    objectCounts: {
      issues: totalIssues,
      projects: projectResults.length,
      workflows: siteEnumResult.workflows.length,
      customFields: siteEnumResult.fields.length,
      boards: 0,
      sprints: 0,
      attachments: totalAttachments,
    },
  };
  db.backupPoints.set(backupPointId, backupPoint);

  // Populate objectSnapshots so the restore engine can build a basket from this backup point.
  // JiraProjectNode snapshots — required for Object Explorer to browse projects when deep-linking.
  for (const pr of projectResults) {
    const nodeKey = `${integrationId}:${pr.projectKey}`;
    const projectNode = db.projectNodes.get(nodeKey);
    const projectData = projectNode || { key: pr.projectKey, integrationId };
    db.objectSnapshots.set(`${backupPointId}:JiraProjectNode:${pr.projectKey}`, {
      backupPointId,
      nodeType: 'JiraProjectNode',
      id: pr.projectKey,
      fields: projectData,
    });
  }
  // Also populate db.searchIssues so the Issue Search tab returns results.
  for (const pr of projectResults) {
    for (const issue of pr.issues || []) {
      const issueId = issue.id || issue.key;
      db.objectSnapshots.set(`${backupPointId}:JiraIssueNode:${issueId}`, {
        backupPointId,
        nodeType: 'JiraIssueNode',
        id: issueId,
        fields: issue.fields || {},
        issueKey: issue.key,
        projectKey: (issue.fields && issue.fields.project && issue.fields.project.key) || pr.projectKey,
      });
      db.searchIssues.set(`${backupPointId}:${issueId}`, {
        id: issueId,
        backupPointId,
        key: issue.key,
        summary: issue.fields?.summary || null,
        issuetype: issue.fields?.issuetype?.name || null,
        status: issue.fields?.status?.name || null,
        statusCategory: issue.fields?.status?.statusCategory?.name || null,
        priority: issue.fields?.priority?.name || null,
        assignee: issue.fields?.assignee || null,
        reporter: issue.fields?.reporter || null,
        labels: issue.fields?.labels || [],
        created: issue.fields?.created || null,
        updated: issue.fields?.updated || null,
        resolved: issue.fields?.resolutiondate || null,
        projectKey: issue.fields?.project?.key || pr.projectKey,
      });
    }
  }
  for (const wf of siteEnumResult.workflows || []) {
    // wf.id from Jira workflow search API is { name, entityId, draft } — extract scalar string
    const wfId = (wf.id && typeof wf.id === 'object')
      ? (wf.id.entityId || wf.id.name || wf.name)
      : (wf.id || wf.name);
    db.objectSnapshots.set(`${backupPointId}:JiraWorkflowNode:${wfId}`, {
      backupPointId,
      nodeType: 'JiraWorkflowNode',
      id: wfId,
      fields: wf,
    });
  }
  for (const field of siteEnumResult.fields || []) {
    db.objectSnapshots.set(`${backupPointId}:JiraCustomFieldDefinitionNode:${field.id}`, {
      backupPointId,
      nodeType: 'JiraCustomFieldDefinitionNode',
      id: field.id,
      fields: field,
    });
  }

  // Build and persist manifests so the Object Explorer diff engine can find entries.
  const issueManifestEntries = [];
  for (const pr of projectResults) {
    for (const issue of pr.issues || []) {
      const issueId = issue.id || issue.key;
      issueManifestEntries.push({ id: issueId, contentHash: computeContentHash(issue.fields || {}) });
    }
  }
  saveManifest(backupPointId, 'JiraIssueNode', issueManifestEntries);

  const projectManifestEntries = projectResults.map(pr => {
    const nodeKey = `${integrationId}:${pr.projectKey}`;
    const projectNode = db.projectNodes.get(nodeKey);
    const projectData = projectNode || { key: pr.projectKey, integrationId };
    return { id: pr.projectKey, contentHash: computeContentHash(projectData) };
  });
  saveManifest(backupPointId, 'JiraProjectNode', projectManifestEntries);

  const workflowManifestEntries = (siteEnumResult.workflows || []).map(wf => {
    const wfId = (wf.id && typeof wf.id === 'object')
      ? (wf.id.entityId || wf.id.name || wf.name)
      : (wf.id || wf.name);
    return { id: wfId, contentHash: computeContentHash(wf) };
  });
  saveManifest(backupPointId, 'JiraWorkflowNode', workflowManifestEntries);

  const fieldManifestEntries = (siteEnumResult.fields || []).map(field => ({
    id: field.id,
    contentHash: computeContentHash(field),
  }));
  saveManifest(backupPointId, 'JiraCustomFieldDefinitionNode', fieldManifestEntries);

  updatePhase(PHASES.MANIFEST_WRITE);
  console.info(`[backup] phase=persisting integrationId=${integrationId}`);
  db.saveDb();
  console.info(`[backup] Backup record persisted: jobId=${backupPointId} connectionId=${integrationId}`);

  updatePhase(PHASES.FINALIZING);
  console.info(`[backup] phase=finalizing integrationId=${integrationId}`);

  return {
    integrationId,
    cloudId,
    backupPointId,
    webhookResult,
    projectResults,
    siteEnumeration: {
      workflowCount: siteEnumResult.workflows.length,
      fieldCount: siteEnumResult.fields.length,
      contextNodeCount: siteEnumResult.contextNodes.length,
    },
    completedAt: now,
  };
}

module.exports = {
  runProjectBackup,
  runIntegrationBackup,
};
