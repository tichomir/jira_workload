'use strict';

/**
 * In-memory data store with file-based persistence.
 *
 * All Maps are loaded from $DATA_DIR/db.json at startup and saved back on
 * graceful shutdown (SIGTERM/SIGINT) and every AUTO_SAVE_INTERVAL_MS.
 *
 * DATA_DIR defaults to ~/.dcc-jira (local) or /data (container, via env).
 * See src/db/persist.js for the serialisation details.
 */

const { loadDb, saveDb, getDataDir } = require('./persist');

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

// ---------------------------------------------------------------------------
// Sprint 3 — Browse, Search, and Object Explorer
// ---------------------------------------------------------------------------

// BackupPoint records (keyed by id)
// Shape: { id, integrationId, createdAt, priorBackupPointId }
const backupPoints = new Map();

// BackupManifest records (keyed by `${backupPointId}:${nodeType}`)
// Shape: { id, backupPointId, nodeType, entries: [{ id, contentHash }], computedAt }
const backupManifests = new Map();

// Search-indexed issue records (keyed by `${backupPointId}:${id}`)
// Shape: { id, backupPointId, key, summary, issuetype, status, statusCategory,
//          priority, assignee, reporter, labels, created, updated, resolved, projectKey }
const searchIssues = new Map();

// Search-indexed attachment records (keyed by `${backupPointId}:${id}`)
// Shape: { id, backupPointId, filename, mimeType, sizeBytes, created, issueId, issueKey, storageKey }
const searchAttachments = new Map();

// Search-indexed board records (keyed by `${backupPointId}:${id}`)
// Shape: { id, backupPointId, name, type, projectKey, sprintCount }
const searchBoards = new Map();

// Search-indexed sprint records (keyed by `${backupPointId}:${id}`)
// Shape: { id, backupPointId, name, state, boardId, startDate, endDate, completeDate, issueCount }
const searchSprints = new Map();

// Search-indexed project records (keyed by id — cross-backup, site-level)
// Shape: { id, siteId, key, name, projectTypeKey, archived, issueCount, lastUpdated }
const searchProjects = new Map();

// UserPreference records (keyed by `${userId}:${integrationId}:${key}`)
// Shape: { id, userId, integrationId, key, value, updatedAt }
const userPreferences = new Map();

// Object snapshot store (keyed by `${backupPointId}:${nodeType}:${id}`)
// Shape: { backupPointId, nodeType, id, fields }
const objectSnapshots = new Map();

// ---------------------------------------------------------------------------
// Sprint 4 — Restore Engine
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sprint 5 — Sensitive Data Intelligence (SDI) Teaser
// ---------------------------------------------------------------------------

// SdiScanResult records (keyed by scanId)
// Shape: { id, backupPointId, integrationId, cloudId, status, startedAt, completedAt,
//          errorMessage, totalFilesScanned, totalFilesSkipped, totalMatchCount,
//          findings: [SdiFindingSummary], regulationMap: [SdiRegulationEntry] }
const sdiScanResults = new Map();

// ---------------------------------------------------------------------------
// Sprint 4 — Restore Engine
// ---------------------------------------------------------------------------

// BackupJob records (keyed by jobId)
// Shape: { id, integrationId, status, triggeredAt, completedAt, error, result }
const backupJobs = new Map();

// RestoreJob records (keyed by restoreJobId)
// Shape: { restoreJobId, status, conflictModeEffective, conflictModeDowngradeReason,
//          destination, validationWarnings, stageResults, currentStage,
//          pendingConflicts: [{ itemId, objectType }], exportArchiveKey, createdAt }
const restoreJobs = new Map();

// ExportArchive records (keyed by restoreJobId)
// Shape: { restoreJobId, manifest: [...], objects: { [filename]: {...} }, attachments: [...] }
const exportArchives = new Map();

// Restored objects at destination (keyed by `${restoreJobId}:${objectType}:${id}`)
// Shape: { restoreJobId, objectType, id, targetId, fields, appliedConstraints }
const restoredObjects = new Map();

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

// ---------------------------------------------------------------------------
// Persistence — assemble the export object first, then load from disk.
// ---------------------------------------------------------------------------

const db = {
  connections,
  pendingStates,
  cloudSites,
  lifecycleEvents,
  scopeValidations,
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
  // Sprint 3
  backupPoints,
  backupManifests,
  searchIssues,
  searchAttachments,
  searchBoards,
  searchSprints,
  searchProjects,
  userPreferences,
  objectSnapshots,
  // Sprint 4
  restoreJobs,
  exportArchives,
  restoredObjects,
  // Sprint 5
  sdiScanResults,
  // Sprint 12
  backupJobs,
};

// Load persisted state synchronously at module load time so all routes start
// with the correct data.  DATA_DIR is resolved inside persist.js.
loadDb(db);

// Auto-save every 30 seconds to capture mutations without requiring every
// route to call saveDb explicitly.
const AUTO_SAVE_INTERVAL_MS = 30_000;
const _autoSaveTimer = setInterval(() => saveDb(db), AUTO_SAVE_INTERVAL_MS);
if (_autoSaveTimer.unref) _autoSaveTimer.unref(); // don't block process exit

// Graceful-shutdown hooks: save before process terminates.
function _shutdown(signal) {
  process.stdout.write(`[db] Received ${signal} — saving db to disk…\n`);
  saveDb(db);
  process.exit(0);
}
process.once('SIGTERM', () => _shutdown('SIGTERM'));
process.once('SIGINT',  () => _shutdown('SIGINT'));

module.exports = {
  ...db,
  pruneExpiredStates,
  saveDb: () => saveDb(db),
  getDataDir,
};
