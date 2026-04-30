'use strict';

/**
 * Sprint 5 — SDI Teaser API Routes
 *
 * Endpoints:
 *   POST /api/v1/sdi/scan/:backupPointId/trigger  — Trigger background scan (202)
 *   GET  /api/v1/sdi/scan/:backupPointId          — Get latest scan result for backup point
 *   GET  /api/sdi/findings                        — Get aggregated findings (acceptance criteria endpoint)
 *   GET  /api/v1/sdi/scans                        — List scan results for an integration
 *
 * HIPAA is never present in any response (enforced by regulation config and orchestrator).
 */

const express = require('express');
const db = require('../db');
const {
  triggerScan,
  getLatestScanResult,
  listScanResults,
} = require('../services/sdiScanOrchestrator');
const { SDI_REGULATION_CONFIG } = require('../config/sdiRegulations');

const router = express.Router();

function errorResponse(res, status, code, message) {
  return res.status(status).json({ error: code, message });
}

// ---------------------------------------------------------------------------
// POST /api/v1/sdi/scan/:backupPointId/trigger
// ---------------------------------------------------------------------------

router.post('/scan/:backupPointId/trigger', (req, res) => {
  const { backupPointId } = req.params;

  if (!db.backupPoints.has(backupPointId)) {
    return errorResponse(res, 404, 'BACKUP_POINT_NOT_FOUND',
      `Backup point ${backupPointId} not found`);
  }

  // Check for already-running scan
  for (const r of db.sdiScanResults.values()) {
    if (r.backupPointId === backupPointId && r.status === 'running') {
      return errorResponse(res, 409, 'SDI_SCAN_ALREADY_RUNNING',
        `An SDI scan is already running for backup point ${backupPointId}`);
    }
  }

  const bp = db.backupPoints.get(backupPointId);
  const integrationId = (bp && bp.integrationId) || '';
  const cloudId       = (bp && bp.cloudId)       || '';

  const triggerResponse = triggerScan(backupPointId, integrationId, cloudId, null);

  return res.status(202).json(triggerResponse);
});

// ---------------------------------------------------------------------------
// GET /api/v1/sdi/scan/:backupPointId
// ---------------------------------------------------------------------------

router.get('/scan/:backupPointId', (req, res) => {
  const { backupPointId } = req.params;

  const scan = getLatestScanResult(backupPointId);
  if (!scan) {
    return errorResponse(res, 404, 'SDI_SCAN_NOT_FOUND',
      `No SDI scan found for backup point ${backupPointId}`);
  }

  return res.status(200).json({ scan });
});

// ---------------------------------------------------------------------------
// GET /api/v1/sdi/scans?integrationId=:id
// ---------------------------------------------------------------------------

router.get('/scans', (req, res) => {
  const { integrationId } = req.query;
  if (!integrationId) {
    return errorResponse(res, 400, 'MISSING_INTEGRATION_ID', 'integrationId query parameter is required');
  }
  const scans = listScanResults(integrationId);
  return res.status(200).json({ scans });
});

// ---------------------------------------------------------------------------
// GET /api/v1/sdi/findings?backupPointId=:id
// (Also mounted at /api/sdi/findings for acceptance criteria compatibility)
// ---------------------------------------------------------------------------

router.get('/findings', (req, res) => {
  const { backupPointId } = req.query;
  if (!backupPointId) {
    return errorResponse(res, 400, 'MISSING_BACKUP_POINT_ID', 'backupPointId query parameter is required');
  }

  const scan = getLatestScanResult(backupPointId);
  if (!scan) {
    // Return empty findings with all regulations shown (no findings yet)
    const regulations = SDI_REGULATION_CONFIG.map(reg => ({
      name: reg.displayName,
      status: 'shown',
    }));
    return res.status(200).json({
      backupPointId,
      findings: [],
      regulations,
    });
  }

  // Map findings to simplified API shape
  const findings = scan.findings.map(f => ({
    dataElementType: f.dataElementType,
    fileType: f.fileType,
    matchCount: f.matchCount,
  }));

  // Map regulation map to { name, status } shape
  const detectedTypes = new Set(findings.map(f => f.dataElementType));
  const regulations = SDI_REGULATION_CONFIG.map(reg => {
    let status;
    if (reg.status === 'active' && reg.triggerDataElementTypes.some(t => detectedTypes.has(t))) {
      status = 'active';
    } else {
      status = 'shown';
    }
    return { name: reg.displayName, status };
  });

  return res.status(200).json({
    backupPointId,
    findings,
    regulations,
  });
});

module.exports = router;
