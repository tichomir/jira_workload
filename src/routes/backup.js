'use strict';

/**
 * Backup pipeline routes:
 *   POST /api/v1/integrations/:id/backup          - Trigger a backup run for an integration
 *   POST /api/v1/integrations/:id/sync            - Manual Sync Now (Data Scope refresh)
 *   GET  /api/v1/integrations/:id/sync/config     - Get DataScopeRefreshConfig
 *   POST /api/v1/purge/cascade                    - Purge cascade (with boundary enforcement)
 *   GET  /api/v1/integrations/:id/backup/run-state - Get backup run states for an integration
 *   GET  /api/v1/integrations/:id/webhooks         - Get webhook registrations
 *   GET  /api/v1/integrations/:id/attachments      - Get attachment manifest
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { runIntegrationBackup } = require('../services/backupEngine');
const { triggerManualSync, getOrCreateRefreshConfig } = require('../services/dataScopeRefresh');
const { assertPurgeCascadeAllowed } = require('../services/purgeCascade');

const router = express.Router();

function errorResponse(res, status, code, message) {
  return res.status(status).json({ error: code, message });
}

// ---------------------------------------------------------------------------
// POST /api/v1/integrations/:id/backup
// Trigger an async backup run. Returns 202 immediately with {jobId, status}.
// ---------------------------------------------------------------------------
router.post('/:id/backup', (req, res) => {
  const integrationId = req.params.id;
  const connection = db.connections.get(integrationId);
  if (!connection) {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No connection found with this ID');
  }
  if (connection.status === 'soft_deleted' || connection.status === 'hard_deleted') {
    return errorResponse(res, 409, 'CONNECTION_DELETED', 'Cannot backup a deleted connection');
  }

  const jobId = uuidv4();
  const now = new Date().toISOString();
  const job = { id: jobId, integrationId, status: 'running', triggeredAt: now, completedAt: null, error: null };
  db.backupJobs.set(jobId, job);

  // Fire-and-forget — respond 202 immediately
  runIntegrationBackup(integrationId).then((result) => {
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.result = result;
    job.backupPointId = result.backupPointId || null;
    db.backupJobs.set(jobId, job);
  }).catch((err) => {
    console.error(`[backup] Backup run failed: jobId=${jobId} connectionId=${integrationId}`, err);
    job.status = 'failed';
    job.completedAt = new Date().toISOString();
    job.error = err.message;
    db.backupJobs.set(jobId, job);
  });

  return res.status(202).json({ jobId, status: 'running', triggeredAt: now });
});

// ---------------------------------------------------------------------------
// GET /api/v1/integrations/:id/backup/run-states  (declared before /:jobId to take priority)
// Return backup run states for this integration.
// ---------------------------------------------------------------------------
router.get('/:id/backup/run-states', (req, res) => {
  const integrationId = req.params.id;
  const connection = db.connections.get(integrationId);
  if (!connection) {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No connection found with this ID');
  }

  const runStates = [];
  for (const state of db.backupRunStates.values()) {
    if (state.integrationId === integrationId) {
      runStates.push({
        id: state.id,
        projectKey: state.projectKey,
        lastBackupTimestamp: state.lastBackupTimestamp,
        lastRunStatus: state.lastRunStatus,
        lastRunCompletedAt: state.lastRunCompletedAt,
      });
    }
  }

  return res.status(200).json({ integrationId, runStates });
});

// ---------------------------------------------------------------------------
// GET /api/v1/integrations/:id/backup/:jobId
// Poll a specific backup job status.
// ---------------------------------------------------------------------------
router.get('/:id/backup/:jobId', (req, res) => {
  const { id: integrationId, jobId } = req.params;
  const connection = db.connections.get(integrationId);
  if (!connection) {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No connection found with this ID');
  }

  const job = db.backupJobs.get(jobId);
  if (!job || job.integrationId !== integrationId) {
    return errorResponse(res, 404, 'BACKUP_JOB_NOT_FOUND', `Backup job ${jobId} not found`);
  }

  return res.status(200).json({ jobId: job.id, integrationId: job.integrationId, status: job.status, triggeredAt: job.triggeredAt, completedAt: job.completedAt, error: job.error || null });
});

// ---------------------------------------------------------------------------
// GET /api/v1/integrations/:id/backup-points  (also aliased as /:id/backups)
// List backup points for an integration, sorted by createdAt DESC.
// ---------------------------------------------------------------------------
function listBackupPoints(req, res) {
  const integrationId = req.params.id;
  const connection = db.connections.get(integrationId);
  if (!connection) {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No connection found with this ID');
  }

  const points = [];
  for (const bp of db.backupPoints.values()) {
    if (bp.integrationId !== integrationId) continue;
    points.push({
      id: bp.id,
      createdAt: bp.createdAt,
      priorBackupPointId: bp.priorBackupPointId || null,
      status: bp.status || 'completed',
      objectCounts: bp.objectCounts || { issues: 0, workflows: 0, customFieldDefinitions: 0, attachments: 0 },
    });
  }

  points.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const cursor = req.query.cursor || null;
  let startIdx = 0;
  if (cursor) {
    const idx = points.findIndex(p => p.id === cursor);
    if (idx !== -1) startIdx = idx + 1;
  }
  const page = points.slice(startIdx, startIdx + limit);
  const nextCursor = startIdx + limit < points.length ? page[page.length - 1].id : null;

  return res.status(200).json({ integrationId, backupPoints: page, total: points.length, nextCursor });
}

router.get('/:id/backup-points', listBackupPoints);
router.get('/:id/backups', listBackupPoints);

// ---------------------------------------------------------------------------
// POST /api/v1/integrations/:id/sync
// Manual Sync Now trigger. Returns job details.
// Returns 202 if a job is already in progress.
// ---------------------------------------------------------------------------
router.post('/:id/sync', (req, res) => {
  const integrationId = req.params.id;
  const connection = db.connections.get(integrationId);
  if (!connection) {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No connection found with this ID');
  }
  if (connection.status === 'soft_deleted' || connection.status === 'hard_deleted') {
    return errorResponse(res, 409, 'CONNECTION_DELETED', 'Cannot sync a deleted connection');
  }

  const { job, alreadyInProgress } = triggerManualSync(integrationId);

  const status = alreadyInProgress ? 202 : 200;
  return res.status(status).json({
    jobId: job.id,
    status: job.status,
    triggeredAt: job.triggeredAt,
    alreadyInProgress,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/integrations/:id/sync/config
// Return the DataScopeRefreshConfig for the integration.
// ---------------------------------------------------------------------------
router.get('/:id/sync/config', (req, res) => {
  const integrationId = req.params.id;
  const connection = db.connections.get(integrationId);
  if (!connection) {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No connection found with this ID');
  }

  const config = getOrCreateRefreshConfig(integrationId);
  return res.status(200).json({
    id: config.id,
    integrationId: config.integrationId,
    refreshIntervalHours: config.refreshIntervalHours,
    lastRefreshedAt: config.lastRefreshedAt,
    nextScheduledAt: config.nextScheduledAt,
    manualSyncPending: config.manualSyncPending,
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/purge/cascade
// Validate and execute a purge cascade. Enforces boundary exclusions.
// Body: { nodeType, targetId }
// Returns 409 with PURGE_CASCADE_BOUNDARY_VIOLATION for excluded node types.
// ---------------------------------------------------------------------------
router.post('/purge/cascade', (req, res) => {
  // Note: this is mounted at /api/v1/integrations so path is relative
  // The actual mount in app.js uses a separate prefix; see app.js for exact path.
  const { nodeType, targetId } = req.body || {};

  if (!nodeType) {
    return errorResponse(res, 400, 'MISSING_NODE_TYPE', 'nodeType is required');
  }

  try {
    assertPurgeCascadeAllowed(nodeType);
  } catch (err) {
    if (err.code === 'PURGE_CASCADE_BOUNDARY_VIOLATION') {
      return res.status(409).json({
        error: err.code,
        message: err.message,
        nodeType,
      });
    }
    throw err;
  }

  // Cascade allowed — in production this would trigger actual purge logic
  return res.status(200).json({
    nodeType,
    targetId: targetId || null,
    status: 'cascade_accepted',
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/integrations/:id/backup/run-states
// Return backup run states for this integration.
// ---------------------------------------------------------------------------
router.get('/:id/backup/run-states', (req, res) => {
  const integrationId = req.params.id;
  const connection = db.connections.get(integrationId);
  if (!connection) {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No connection found with this ID');
  }

  const runStates = [];
  for (const state of db.backupRunStates.values()) {
    if (state.integrationId === integrationId) {
      runStates.push({
        id: state.id,
        projectKey: state.projectKey,
        lastBackupTimestamp: state.lastBackupTimestamp,
        lastRunStatus: state.lastRunStatus,
        lastRunCompletedAt: state.lastRunCompletedAt,
      });
    }
  }

  return res.status(200).json({ integrationId, runStates });
});

// ---------------------------------------------------------------------------
// GET /api/v1/integrations/:id/webhooks
// Return webhook registrations for this integration.
// ---------------------------------------------------------------------------
router.get('/:id/webhooks', (req, res) => {
  const integrationId = req.params.id;
  const connection = db.connections.get(integrationId);
  if (!connection) {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No connection found with this ID');
  }

  const registrations = [];
  for (const reg of db.webhookRegistrations.values()) {
    if (reg.integrationId === integrationId) {
      registrations.push({
        id: reg.id,
        webhookId: reg.webhookId,
        cloudId: reg.cloudId,
        events: reg.events,
        jqlFilter: reg.jqlFilter,
        registeredAt: reg.registeredAt,
        expiresAt: reg.expiresAt,
        deletedAt: reg.deletedAt,
      });
    }
  }

  return res.status(200).json({ integrationId, registrations });
});

// ---------------------------------------------------------------------------
// GET /api/v1/integrations/:id/attachments
// Return the attachment manifest for this integration.
// ---------------------------------------------------------------------------
router.get('/:id/attachments', (req, res) => {
  const integrationId = req.params.id;
  const connection = db.connections.get(integrationId);
  if (!connection) {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No connection found with this ID');
  }

  const entries = [];
  for (const entry of db.attachmentManifestEntries.values()) {
    if (entry.integrationId === integrationId) {
      entries.push({
        id: entry.id,
        attachmentId: entry.attachmentId,
        issueKey: entry.issueKey,
        filename: entry.filename,
        sidecarOnly: entry.sidecarOnly,
        binaryStorageRef: entry.binaryStorageRef,
        checksum: entry.checksum,
        downloadedAt: entry.downloadedAt,
      });
    }
  }

  return res.status(200).json({ integrationId, entries });
});

// ---------------------------------------------------------------------------
// POST /api/v1/integrations/:id/restore-backup
// Convenience endpoint: initiate a data restore from a backup point.
// Body: { backupPointId, conflictMode?, destination? }
// Returns restore job status.
// ---------------------------------------------------------------------------
router.post('/:id/restore-backup', (req, res) => {
  const integrationId = req.params.id;
  const connection = db.connections.get(integrationId);
  if (!connection) {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No connection found with this ID');
  }

  const { backupPointId, conflictMode, destination } = req.body || {};
  if (!backupPointId) {
    return errorResponse(res, 400, 'MISSING_BACKUP_POINT', 'backupPointId is required');
  }
  if (!db.backupPoints.has(backupPointId)) {
    return errorResponse(res, 404, 'BACKUP_POINT_NOT_FOUND', `Backup point ${backupPointId} not found`);
  }
  if (conflictMode === 'merge') {
    return errorResponse(res, 400, 'INVALID_CONFLICT_MODE', 'conflictMode "merge" is permanently excluded');
  }

  // Delegate to the restore engine
  const { initiateRestore } = require('../services/restoreOrchestrator');
  const dest = destination || { type: 'original' };
  const restoreRequest = {
    backupPointId,
    sourceSiteId: connection.cloudId,
    destination: dest,
    conflictMode: conflictMode || 'skip',
    objectSelection: { includeAll: true },
  };

  const result = initiateRestore(restoreRequest);

  if (result.__validationError) {
    const err = result.blockingError;
    return errorResponse(res, 409, err.errorCode || 'VALIDATION_FAILED', err.detail || 'Pre-execution validation failed');
  }
  if (result.__fieldMappingBlocked) {
    return errorResponse(res, 409, 'CUSTOM_FIELD_MAPPING_BLOCKED',
      `Cross-site restore blocked: required custom fields not found on target site`);
  }

  return res.status(200).json({
    restoreJobId: result.restoreJobId,
    status: result.status,
    conflictModeEffective: result.conflictModeEffective,
    currentStage: result.currentStage,
  });
});

module.exports = router;
