'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { decrypt } = require('./crypto');
const { runJqlEnumeration } = require('./jqlEnumeration');
const { ensureWebhookRegistered, buildWebhookJqlFilter } = require('./webhookRegistration');
const { processAttachments } = require('./attachmentMaterialisation');
const { runSiteEnumeration } = require('./siteObjectEnumeration');
const { tagIssueNodes } = require('./archiveScope');

/**
 * Get the decrypted access token for a connection.
 * @param {object} connection
 * @returns {string}
 */
function getAccessToken(connection) {
  return decrypt(connection.accessToken);
}

/**
 * Run a full backup for a single project within an integration.
 * Orchestrates: JQL enumeration → attachment materialisation → archive scope tagging.
 *
 * @param {string} integrationId
 * @param {string} cloudId
 * @param {string} projectKey
 * @param {string} accessToken
 * @returns {Promise<{issues: object[], mode: string, runState: object, attachmentEntries: object[]}>}
 */
async function runProjectBackup(integrationId, cloudId, projectKey, accessToken) {
  const backupPointId = uuidv4();

  // JQL enumeration (full or incremental)
  const { issues, runState, mode } = await runJqlEnumeration(
    integrationId,
    cloudId,
    projectKey,
    accessToken
  );

  // Attachment materialisation
  const attachmentEntries = await processAttachments(
    integrationId,
    backupPointId,
    issues,
    cloudId,
    accessToken
  );

  // Archive scope attribute tagging
  tagIssueNodes(integrationId, issues);

  return { issues, mode, runState, attachmentEntries, backupPointId };
}

/**
 * Run a full integration backup:
 * 1. Ensure webhook registered (idempotent)
 * 2. For each project in scope: run project backup
 * 3. Run site-level enumeration (workflows, custom fields, contexts)
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
  const accessToken = getAccessToken(connection);

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
  if (connection.projectScopeMode === 'selected' && connection.selectedProjectIds.length > 0) {
    projectKeys = connection.selectedProjectIds;
  } else {
    // All projects mode — derive from projectNodes or use a placeholder
    // In a real implementation, enumerate projects from Jira API
    projectKeys = [...db.projectNodes.values()]
      .filter((p) => p.integrationId === integrationId)
      .map((p) => p.projectKey);
  }

  // 3. Run per-project backup
  const projectResults = [];
  for (const projectKey of projectKeys) {
    const result = await runProjectBackup(integrationId, cloudId, projectKey, accessToken);
    projectResults.push({ projectKey, ...result });
  }

  // 4. Site-level enumeration (runs regardless of project scope)
  const siteEnumResult = await runSiteEnumeration(cloudId, accessToken);

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
      workflows: siteEnumResult.workflows.length,
      customFieldDefinitions: siteEnumResult.fields.length,
      attachments: totalAttachments,
    },
  };
  db.backupPoints.set(backupPointId, backupPoint);
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
  getAccessToken,
};
