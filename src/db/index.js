'use strict';

/**
 * In-memory data store.
 * In production, replace with a real database (PostgreSQL, etc.).
 * All collections are plain Maps keyed by record ID.
 */

// OAuthConnection records (keyed by id)
const connections = new Map();

// Pending OAuth state records (keyed by state UUID)
// Shape: { state, codeVerifier, userId, expiresAt, clientId?, clientSecret?, redirectUri?, path }
const pendingStates = new Map();

// CloudSite records (keyed by id)
const cloudSites = new Map();

// IntegrationLifecycleEvent records (keyed by id)
const lifecycleEvents = new Map();

// ScopeValidationResult records (keyed by id)
const scopeValidations = new Map();

// ---------------------------------------------------------------------------
// Sprint 2 — Backup Discovery and Data Ingestion
// ---------------------------------------------------------------------------

// BackupRunState records (keyed by id)
// Shape: { id, integrationId, cloudId, projectKey, lastBackupTimestamp, lastRunStatus, lastRunCompletedAt }
const backupRunStates = new Map();

// WebhookRegistration records (keyed by id)
// Shape: { id, integrationId, cloudId, webhookId, jqlFilter, events, registeredAt, expiresAt, deletedAt }
const webhookRegistrations = new Map();

// AttachmentManifestEntry records (keyed by id)
// Shape: { id, backupPointId, attachmentId, issueKey, filename, mimeType, sizeBytes,
//          binaryStorageRef, sidecarOnly, priorManifestEntryId, downloadedAt, checksum }
const attachmentManifestEntries = new Map();

// DataScopeRefreshConfig records (keyed by integrationId)
// Shape: { id, integrationId, refreshIntervalHours, lastRefreshedAt, nextScheduledAt, manualSyncPending }
const dataScopeRefreshConfigs = new Map();

// SyncJob records (keyed by id)
// Shape: { id, integrationId, status, triggeredAt, completedAt, type }
const syncJobs = new Map();

// SLADomain records (keyed by id)
// Shape: { id, integrationId, name, rpoHours, retentionDays, policyModel, secondaryCopy, archiveCopy, createdAt, updatedAt }
const slaDomains = new Map();

// JiraIssueNode records (keyed by integrationId:issueKey)
const issueNodes = new Map();

// JiraProjectNode records (keyed by integrationId:projectKey)
const projectNodes = new Map();

// JiraSprintNode records (keyed by integrationId:sprintId)
const sprintNodes = new Map();

// JiraWorkflowNode records (keyed by cloudId:workflowId)
const workflowNodes = new Map();

// JiraCustomFieldDefinitionNode records (keyed by cloudId:fieldId)
const customFieldDefinitions = new Map();

// JiraCustomFieldContextNode records (keyed by cloudId:fieldId:contextId)
const customFieldContextNodes = new Map();

/**
 * Clean up expired state records (called lazily).
 */
function pruneExpiredStates() {
  const now = new Date();
  for (const [key, value] of pendingStates.entries()) {
    if (new Date(value.expiresAt) < now) {
      pendingStates.delete(key);
    }
  }
}

module.exports = {
  connections,
  pendingStates,
  cloudSites,
  lifecycleEvents,
  scopeValidations,
  pruneExpiredStates,
  // Sprint 2
  backupRunStates,
  webhookRegistrations,
  attachmentManifestEntries,
  dataScopeRefreshConfigs,
  syncJobs,
  slaDomains,
  issueNodes,
  projectNodes,
  sprintNodes,
  workflowNodes,
  customFieldDefinitions,
  customFieldContextNodes,
};
