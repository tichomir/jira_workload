'use strict';

/**
 * Sprint 5 — SDI Teaser: Scan Orchestrator
 *
 * Manages SDI scan jobs lifecycle and orchestrates the full scan pipeline:
 *   1. File enumeration (from backup point data)
 *   2. Per-file text extraction
 *   3. Pattern scanning
 *   4. Findings aggregation by (dataElementType × fileType) dimension
 *   5. Regulation map computation
 *   6. Persistence to db.sdiScanResults
 *
 * ADR-SDI-003: One SdiScanResult per (backupPointId, scan run).
 *              On re-scan: previous result status set to 'superseded'.
 * ADR-SDI-002: Raw matched strings NEVER stored.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { extractText } = require('./sdiExtractors');
const { scanText } = require('./sdiPatternScanner');
const { SDI_FILE_TYPE_EXTRACTOR_MAP } = require('../config/sdiFileTypes');
const { SDI_REGULATION_CONFIG } = require('../config/sdiRegulations');

const path = require('path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the dot-prefixed file extension from a file path/name.
 * Returns lowercase extension or empty string if none.
 */
function getExtension(fileRef) {
  const ext = path.extname(fileRef).toLowerCase();
  return ext;
}

/**
 * Map file extension to SdiFileType string (without the leading dot).
 * Returns null if unsupported.
 */
function fileTypeFromExt(ext) {
  // SDI_FILE_TYPE_EXTRACTOR_MAP keys are dot-prefixed; SdiFileType is without dot
  if (!SDI_FILE_TYPE_EXTRACTOR_MAP[ext]) return null;
  return ext.slice(1); // '.json' → 'json'
}

/**
 * Compute the regulation map from the aggregated findings.
 * All six regulations are always included; Active regulations reflect triggered types.
 *
 * @param {Array<{dataElementType: string, fileType: string, matchCount: number, fileCount: number}>} findings
 * @returns {Array<{regulation: string, displayStatus: string, triggerDataElements: string[]}>}
 */
function computeRegulationMap(findings) {
  if (findings.length === 0) return [];

  const detectedTypes = new Set(findings.map(f => f.dataElementType));

  return SDI_REGULATION_CONFIG.map(reg => {
    if (reg.status === 'active' && reg.triggerDataElementTypes.length > 0) {
      const triggered = reg.triggerDataElementTypes.filter(t => detectedTypes.has(t));
      return {
        regulation: reg.id,
        displayStatus: triggered.length > 0 ? 'active' : 'shown',
        triggerDataElements: triggered,
      };
    }
    return {
      regulation: reg.id,
      displayStatus: 'shown',
      triggerDataElements: [],
    };
  });
}

// ---------------------------------------------------------------------------
// File enumeration from backup point
// ---------------------------------------------------------------------------

/**
 * Enumerate virtual file entries for a backup point from the in-memory store.
 * Each entry: { fileRef, ext, content }
 *
 * Sources:
 *  1. objectSnapshots keyed ${backupPointId}:*:* — serialized as JSON text
 *  2. attachmentManifestEntries for the backupPointId — content from storageKey lookup if available
 *
 * @param {string} backupPointId
 * @returns {Array<{fileRef: string, ext: string, content: string|Buffer, sizeBytes: number}>}
 */
function enumerateBackupPointFiles(backupPointId) {
  const files = [];

  // Source 1: object snapshots → serialize as JSON
  for (const [key, snapshot] of db.objectSnapshots.entries()) {
    if (!key.startsWith(`${backupPointId}:`)) continue;
    const content = JSON.stringify(snapshot);
    files.push({
      fileRef: `snapshots/${key}.json`,
      ext: '.json',
      content,
      sizeBytes: Buffer.byteLength(content, 'utf-8'),
    });
  }

  // Source 2: attachment manifest entries → use filename extension if supported
  for (const entry of db.attachmentManifestEntries.values()) {
    if (entry.backupPointId !== backupPointId) continue;
    const filename = entry.filename || '';
    const ext = path.extname(filename).toLowerCase();
    if (!SDI_FILE_TYPE_EXTRACTOR_MAP[ext]) continue; // unsupported extension
    // In the in-memory store, attachment binary content is not materialised.
    // Skip attachments without in-memory content (non-blocking per design).
    if (!entry._testContent) continue;
    files.push({
      fileRef: `attachments/${entry.id}/${filename}`,
      ext,
      content: entry._testContent,
      sizeBytes: entry._testContent.length,
    });
  }

  return files;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate per-file scan hits into (dataElementType × fileType) summaries.
 *
 * @param {Array<{fileType: string, dataElementType: string, matchCount: number}>} hits
 * @returns {Array<{dataElementType: string, fileType: string, matchCount: number, fileCount: number}>}
 */
function aggregateFindings(hits) {
  const buckets = new Map(); // key: `${dataElementType}:${fileType}`

  for (const hit of hits) {
    const key = `${hit.dataElementType}:${hit.fileType}`;
    if (!buckets.has(key)) {
      buckets.set(key, { dataElementType: hit.dataElementType, fileType: hit.fileType, matchCount: 0, fileCount: 0 });
    }
    const bucket = buckets.get(key);
    bucket.matchCount += hit.matchCount;
    bucket.fileCount  += 1;
  }

  return Array.from(buckets.values());
}

// ---------------------------------------------------------------------------
// Core scan execution
// ---------------------------------------------------------------------------

/**
 * Run the SDI scan pipeline for a backup point.
 * Updates the sdiScanResult record in db.sdiScanResults during execution.
 *
 * @param {string} scanId
 * @param {string} backupPointId
 * @param {Array|null} fileEntries - Override file list (for testing / injection); null to enumerate from db
 */
async function runScan(scanId, backupPointId, fileEntries) {
  const result = db.sdiScanResults.get(scanId);
  if (!result) throw new Error(`SDI scan result ${scanId} not found`);

  // Mark as running
  result.status = 'running';

  const filesToScan = fileEntries || enumerateBackupPointFiles(backupPointId);

  const allHits = [];
  let totalFilesScanned = 0;
  let totalFilesSkipped = 0;

  for (const file of filesToScan) {
    const { fileRef, ext, content, sizeBytes } = file;
    const fileType = fileTypeFromExt(ext);
    if (!fileType) {
      totalFilesSkipped++;
      continue;
    }

    let text;
    try {
      text = await extractText(ext, content, sizeBytes);
    } catch (extractErr) {
      // Non-blocking: log skip and continue
      totalFilesSkipped++;
      continue;
    }

    // Scan for all data element types
    const counts = scanText(text, ext);
    for (const [dataElementType, matchCount] of Object.entries(counts)) {
      if (matchCount > 0) {
        // SdiScanHit (in-memory only, per ADR-SDI-003 — per-file detail not persisted)
        allHits.push({ fileType, dataElementType, matchCount });
      }
    }
    totalFilesScanned++;
  }

  // Aggregate to (dataElementType × fileType) dimension
  const findings = aggregateFindings(allHits);
  const regulationMap = computeRegulationMap(findings);
  const totalMatchCount = findings.reduce((sum, f) => sum + f.matchCount, 0);

  // Update persisted result (no raw match strings)
  result.status = 'complete';
  result.completedAt = new Date().toISOString();
  result.totalFilesScanned = totalFilesScanned;
  result.totalFilesSkipped = totalFilesSkipped;
  result.totalMatchCount = totalMatchCount;
  result.findings = findings;
  result.regulationMap = regulationMap;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Trigger a new SDI scan for a backup point.
 * Marks any previous scan for the same backup point as 'superseded'.
 *
 * @param {string} backupPointId
 * @param {string} integrationId
 * @param {string} cloudId
 * @param {Array|null} fileEntries - Optional file list override (for testing)
 * @returns {{ scanId: string, backupPointId: string, status: 'pending', message: string }}
 */
function triggerScan(backupPointId, integrationId, cloudId, fileEntries) {
  // Mark prior scans as superseded (ADR-SDI-003)
  for (const prior of db.sdiScanResults.values()) {
    if (prior.backupPointId === backupPointId && prior.status !== 'superseded') {
      prior.status = 'superseded';
    }
  }

  const scanId = uuidv4();
  const now = new Date().toISOString();

  const scanResult = {
    id: scanId,
    backupPointId,
    integrationId: integrationId || '',
    cloudId: cloudId || '',
    status: 'pending',
    startedAt: now,
    completedAt: null,
    errorMessage: null,
    totalFilesScanned: 0,
    totalFilesSkipped: 0,
    totalMatchCount: 0,
    findings: [],
    regulationMap: [],
  };

  db.sdiScanResults.set(scanId, scanResult);

  // Run scan asynchronously (background job — fire and forget in this in-memory implementation)
  setImmediate(() => {
    runScan(scanId, backupPointId, fileEntries || null).catch(err => {
      const r = db.sdiScanResults.get(scanId);
      if (r) {
        r.status = 'failed';
        r.completedAt = new Date().toISOString();
        r.errorMessage = err.message;
      }
    });
  });

  return {
    scanId,
    backupPointId,
    status: 'pending',
    message: 'SDI scan job enqueued',
  };
}

/**
 * Trigger scan and wait for it to complete (synchronous test helper).
 * NOT for production use — only for tests that need deterministic results.
 */
async function triggerScanSync(backupPointId, integrationId, cloudId, fileEntries) {
  // Supersede prior scans
  for (const prior of db.sdiScanResults.values()) {
    if (prior.backupPointId === backupPointId && prior.status !== 'superseded') {
      prior.status = 'superseded';
    }
  }

  const scanId = uuidv4();
  const now = new Date().toISOString();

  const scanResult = {
    id: scanId,
    backupPointId,
    integrationId: integrationId || '',
    cloudId: cloudId || '',
    status: 'pending',
    startedAt: now,
    completedAt: null,
    errorMessage: null,
    totalFilesScanned: 0,
    totalFilesSkipped: 0,
    totalMatchCount: 0,
    findings: [],
    regulationMap: [],
  };

  db.sdiScanResults.set(scanId, scanResult);
  await runScan(scanId, backupPointId, fileEntries || null);

  return scanId;
}

/**
 * Get the latest non-superseded scan result for a backup point.
 * @param {string} backupPointId
 * @returns {Object|null}
 */
function getLatestScanResult(backupPointId) {
  let latest = null;
  for (const result of db.sdiScanResults.values()) {
    if (result.backupPointId === backupPointId && result.status !== 'superseded') {
      if (!latest || result.startedAt > latest.startedAt) {
        latest = result;
      }
    }
  }
  return latest;
}

/**
 * List scan results for an integration.
 * @param {string} integrationId
 * @returns {Array}
 */
function listScanResults(integrationId) {
  const results = [];
  for (const r of db.sdiScanResults.values()) {
    if (r.integrationId === integrationId) {
      results.push({
        id: r.id,
        backupPointId: r.backupPointId,
        status: r.status,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        totalMatchCount: r.totalMatchCount,
      });
    }
  }
  results.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return results;
}

module.exports = {
  triggerScan,
  triggerScanSync,
  getLatestScanResult,
  listScanResults,
  computeRegulationMap,
  aggregateFindings,
  enumerateBackupPointFiles,
  // runScan exported for direct test use
  runScan,
};
