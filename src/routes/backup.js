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
// Trigger a backup run for the integration.
// ---------------------------------------------------------------------------
router.post('/:id/backup', async (req, res) => {
  const integrationId = req.params.id;
  const connection = db.connections.get(integrationId);
  if (!connection) {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No connection found with this ID');
  }
  if (connection.status === 'soft_deleted' || connection.status === 'hard_deleted') {
    return errorResponse(res, 409, 'CONNECTION_DELETED', 'Cannot backup a deleted connection');
  }

  try {
    const result = await runIntegrationBackup(integrationId);
    return res.status(200).json(result);
  } catch (err) {
    console.error('Backup run failed:', err);
    return errorResponse(res, 500, 'BACKUP_FAILED', err.message);
  }
});

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

module.exports = router;
