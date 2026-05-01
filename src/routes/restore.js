'use strict';

/**
 * Sprint 4 — Restore Engine API Routes
 *
 * All endpoints mounted at /api/v1/restore
 *
 * POST   /api/v1/restore                              — Initiate restore
 * GET    /api/v1/restore/:restoreJobId                — Poll job status
 * POST   /api/v1/restore/:restoreJobId/conflict-decision — Submit ask-mode decision
 * POST   /api/v1/restore/validate                     — Dry-run validation only
 * GET    /api/v1/restore/:restoreJobId/export         — Download export archive
 */

const express = require('express');
const db = require('../db');
const {
  initiateRestore,
  submitConflictDecision,
  buildBasket,
  resolveConflictMode,
  buildBasketSummary,
} = require('../services/restoreOrchestrator');
const { runValidationPipeline } = require('../services/validationService');
const { buildFieldMap } = require('../services/customFieldMappingService');

const router = express.Router();

function errorResponse(res, status, code, message, extra) {
  return res.status(status).json({ error: code, message, ...(extra || {}) });
}

// ── POST /api/v1/restore ──────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const body = req.body || {};
  const { backupPointId, sourceSiteId, destination, conflictMode, objectSelection, connectionId } = body;

  // Validate required fields
  if (!backupPointId) {
    return errorResponse(res, 400, 'MISSING_BACKUP_POINT', 'backupPointId is required');
  }
  if (!sourceSiteId) {
    return errorResponse(res, 400, 'MISSING_SOURCE_SITE', 'sourceSiteId is required');
  }
  if (!destination || !destination.type) {
    return errorResponse(res, 400, 'MISSING_DESTINATION', 'destination.type is required');
  }
  if (!objectSelection) {
    return errorResponse(res, 400, 'MISSING_OBJECT_SELECTION', 'objectSelection is required');
  }

  // ADR-001: merge mode is permanently excluded
  if (conflictMode === 'merge') {
    return errorResponse(res, 400, 'INVALID_CONFLICT_MODE',
      'conflictMode "merge" is permanently excluded. Use "skip", "override", or "ask".');
  }

  const restoreRequest = { backupPointId, sourceSiteId, destination, conflictMode, objectSelection, connectionId };
  let result;
  try {
    result = await initiateRestore(restoreRequest);
  } catch (err) {
    return errorResponse(res, 500, 'RESTORE_FAILED', err.message || 'Restore pipeline failed');
  }

  // Validation blocking error
  if (result.__validationError) {
    const err = result.blockingError;
    return errorResponse(res, 409, err.errorCode || 'VALIDATION_FAILED', err.detail || 'Pre-execution validation failed', {
      blockingError: err,
      warnings: result.warnings,
    });
  }

  // Custom field mapping blocked
  if (result.__fieldMappingBlocked) {
    return errorResponse(res, 409, 'CUSTOM_FIELD_MAPPING_BLOCKED',
      `Cross-site restore blocked: required custom fields not found on target site: ${result.missingRequired.join(', ')}`,
      { missingRequired: result.missingRequired, warnings: result.warnings },
    );
  }

  return res.status(200).json(result);
});

// ── POST /api/v1/restore/validate ─────────────────────────────────────────────
// Must be declared BEFORE /:restoreJobId to avoid route collision.

router.post('/validate', (req, res) => {
  const body = req.body || {};
  const { backupPointId, sourceSiteId, destination, conflictMode, objectSelection } = body;

  if (!backupPointId) {
    return errorResponse(res, 400, 'MISSING_BACKUP_POINT', 'backupPointId is required');
  }
  if (!sourceSiteId) {
    return errorResponse(res, 400, 'MISSING_SOURCE_SITE', 'sourceSiteId is required');
  }
  if (conflictMode === 'merge') {
    return errorResponse(res, 400, 'INVALID_CONFLICT_MODE',
      'conflictMode "merge" is permanently excluded.');
  }

  const dest = destination || { type: 'original' };
  const objSel = objectSelection || { includeAll: true };

  const targetSiteId = dest.type === 'original'
    ? (dest.originalSiteId || sourceSiteId)
    : (dest.targetSiteId || sourceSiteId);
  const targetProjectKey = dest.type === 'original'
    ? (dest.originalProjectKey || '')
    : (dest.targetProjectKey || '');

  const basketItems = buildBasket(backupPointId, objSel);
  const basketTotalItems = basketItems.length;
  const { conflictModeEffective, conflictModeDowngradeReason } = resolveConflictMode(conflictMode, basketTotalItems);
  const includeBoardSprintRestore = basketItems.some(i => i.objectType === 'board' || i.objectType === 'sprint');

  const validationResult = runValidationPipeline({
    restoreRequest: body,
    targetSiteId,
    targetProjectKey,
    basketItems,
    includeBoardSprintRestore,
  });

  // Cross-site field mapping (dry run)
  let customFieldMapping = undefined;
  const isCrossSite = dest.isCrossSite || (dest.type === 'alternate' && dest.targetSiteId && dest.targetSiteId !== sourceSiteId);
  if (isCrossSite) {
    const sourceFieldIds = [];
    for (const item of basketItems) {
      if (item.objectType === 'issue') {
        for (const k of Object.keys(item.fields || {})) {
          if (k.startsWith('customfield_') && !sourceFieldIds.includes(k)) sourceFieldIds.push(k);
        }
      }
    }
    customFieldMapping = buildFieldMap({ sourceSiteId, targetSiteId, sourceFieldIds });
  }

  const basketSummary = buildBasketSummary(basketItems, conflictModeEffective, conflictModeDowngradeReason);

  const response = {
    passed: validationResult.passed,
    warnings: validationResult.warnings,
    basketSummary,
  };
  if (!validationResult.passed) response.blockingError = validationResult.blockingError;
  if (customFieldMapping) response.customFieldMapping = customFieldMapping;

  return res.status(200).json(response);
});

// ── GET /api/v1/restore/:restoreJobId ─────────────────────────────────────────

router.get('/:restoreJobId', (req, res) => {
  const { restoreJobId } = req.params;
  const job = db.restoreJobs.get(restoreJobId);
  if (!job) {
    return errorResponse(res, 404, 'RESTORE_JOB_NOT_FOUND', `Restore job ${restoreJobId} not found`);
  }

  const response = {
    restoreJobId: job.restoreJobId,
    status: job.status,
    currentStage: job.currentStage,
    stageResults: job.stageResults || [],
    validationWarnings: job.validationWarnings || [],
  };
  if (job.exportDownloadUrl) response.exportDownloadUrl = job.exportDownloadUrl;

  return res.status(200).json(response);
});

// ── POST /api/v1/restore/:restoreJobId/conflict-decision ──────────────────────

router.post('/:restoreJobId/conflict-decision', async (req, res) => {
  const { restoreJobId } = req.params;
  const { itemId, decision } = req.body || {};

  if (!itemId) return errorResponse(res, 400, 'MISSING_ITEM_ID', 'itemId is required');
  if (!decision || !['skip', 'override'].includes(decision)) {
    return errorResponse(res, 400, 'INVALID_DECISION', 'decision must be "skip" or "override"');
  }

  try {
    const result = await submitConflictDecision(restoreJobId, itemId, decision);
    return res.status(200).json(result);
  } catch (err) {
    if (err.code === 'RESTORE_JOB_NOT_FOUND') {
      return errorResponse(res, 404, err.code, err.message);
    }
    if (err.code === 'NO_PENDING_CONFLICT' || err.code === 'ASK_MODE_SUPPRESSED') {
      return errorResponse(res, 409, err.code, err.message);
    }
    throw err;
  }
});

// ── GET /api/v1/restore/:restoreJobId/export ──────────────────────────────────

router.get('/:restoreJobId/export', (req, res) => {
  const { restoreJobId } = req.params;
  const job = db.restoreJobs.get(restoreJobId);

  if (!job) {
    return errorResponse(res, 404, 'RESTORE_JOB_NOT_FOUND', `Restore job ${restoreJobId} not found`);
  }
  if (job.destination.type !== 'export') {
    return errorResponse(res, 409, 'NOT_EXPORT_DESTINATION', 'This restore job is not an export-type destination');
  }
  if (job.status !== 'complete') {
    return errorResponse(res, 409, 'EXPORT_NOT_READY', `Export is not ready; current status: ${job.status}`);
  }

  const archive = db.exportArchives.get(restoreJobId);
  if (!archive) {
    return errorResponse(res, 404, 'EXPORT_NOT_FOUND', 'Export archive not found');
  }

  // For json format, return JSON response
  // For json+zip format in production, stream a ZIP. Here we return JSON with zip-compatible manifest.
  const exportFormat = job.destination.exportFormat || 'json+zip';

  if (exportFormat === 'json') {
    return res.status(200).json(archive);
  }

  // json+zip: return JSON with Content-Type application/zip header and structured body.
  // In production this would be a real ZIP stream (requires archiver/jszip dependency).
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="restore-${restoreJobId}.zip"`);
  return res.status(200).json(archive);
});

module.exports = router;
