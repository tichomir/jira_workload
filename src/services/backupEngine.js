'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { getValidAccessToken, createJiraAxiosInstance } = require('./tokenService');

const JIRA_API_BASE = 'https://api.atlassian.com/ex/jira';
const { runJqlEnumeration } = require('./jqlEnumeration');
const { ensureWebhookRegistered, buildWebhookJqlFilter } = require('./webhookRegistration');
const { processAttachments } = require('./attachmentMaterialisation');
const { runSiteEnumeration } = require('./siteObjectEnumeration');
const { tagIssueNodes } = require('./archiveScope');

/**
 * Run a full backup for a single project within an integration.
 * Orchestrates: JQL enumeration → attachment materialisation → archive scope tagging.
 *
 * @param {string} integrationId
 * @param {string} cloudId
 * @param {string} projectKey
 * @param {import('axios').AxiosInstance} jiraAxios  Shared Axios instance with 401 interceptor
 * @returns {Promise<{issues: object[], mode: string, runState: object, attachmentEntries: object[]}>}
 */
async function runProjectBackup(integrationId, cloudId, projectKey, jiraAxios) {
  const backupPointId = uuidv4();

  // JQL enumeration (full or incremental)
  const { issues, runState, mode } = await runJqlEnumeration(
    integrationId,
    cloudId,
    projectKey,
    jiraAxios
  );

  // Attachment materialisation
  const attachmentEntries = await processAttachments(
    integrationId,
    backupPointId,
    issues,
    cloudId,
    jiraAxios
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
 * @returns {Promise<object>}
 */
async function runIntegrationBackup(integrationId) {
  const connection = db.connections.get(integrationId);
  if (!connection) {
    throw new Error(`Connection not found: ${integrationId}`);
  }

  const { cloudId } = connection;

  // Proactive token check: refresh if expiring within 5 minutes.
  // createJiraAxiosInstance uses the fresh token and attaches a 401 interceptor
  // that will transparently refresh and retry if the token expires mid-run.
  const accessToken = await getValidAccessToken(integrationId);
  const jiraAxios = createJiraAxiosInstance(integrationId, accessToken);

  // 1. Ensure webhook is registered (requires manage:jira-webhook scope)
  const hasWebhookScope = connection.grantedScopes &&
    connection.grantedScopes.includes('manage:jira-webhook');

  let webhookResult = null;
  if (hasWebhookScope) {
    const jqlFilter = buildWebhookJqlFilter(connection);
    webhookResult = await ensureWebhookRegistered(integrationId, cloudId, accessToken, jqlFilter);
  }

  // 2. Determine project keys to back up
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

  // 3. Run per-project backup
  const projectResults = [];
  for (const projectKey of projectKeys) {
    const result = await runProjectBackup(integrationId, cloudId, projectKey, jiraAxios);
    projectResults.push({ projectKey, ...result });
  }

  // 4. Site-level enumeration (runs regardless of project scope)
  const siteEnumResult = await runSiteEnumeration(cloudId, jiraAxios);

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
  for (const pr of projectResults) {
    for (const issue of pr.issues || []) {
      const issueId = issue.id || issue.key;
      db.objectSnapshots.set(`${backupPointId}:JiraIssueNode:${issueId}`, {
        backupPointId,
        nodeType: 'JiraIssueNode',
        id: issueId,
        fields: issue.fields || {},
        issueKey: issue.key,
      });
    }
  }
  for (const wf of siteEnumResult.workflows || []) {
    const wfId = wf.id || wf.name;
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

  db.saveDb();
  console.info(`[backup] Backup record persisted: jobId=${backupPointId} connectionId=${integrationId}`);

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
