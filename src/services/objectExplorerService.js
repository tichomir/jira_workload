'use strict';

/**
 * Sprint 3 — Object Explorer Diff Engine
 *
 * Computes ChangeIndicator for each object by comparing the current backup point
 * manifest against the immediately prior manifest (architecture §4.2).
 *
 * ChangeIndicator derivation rules:
 *   Added     — id present in current, absent in prior (or no prior exists)
 *   Modified  — id present in both, contentHash differs
 *   Unchanged — id present in both, contentHash identical
 *   Deleted   — id absent in current, present in prior
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_NODE_TYPES = new Set([
  'JiraProjectNode',
  'JiraIssueNode',
  'JiraAttachmentNode',
  'JiraWorkflowNode',
  'JiraCustomFieldDefinitionNode',
  'JiraCustomFieldContextNode',
  'JiraBoardNode',
  'JiraSprintNode',
]);

const VALID_CHANGE_INDICATORS = new Set(['Added', 'Modified', 'Deleted', 'Unchanged']);

// ─── Hash utilities ───────────────────────────────────────────────────────────

/**
 * Compute SHA-256 of canonical JSON (keys sorted, null fields omitted).
 *
 * @param {object} obj
 * @returns {string} hex SHA-256 digest
 */
function computeContentHash(obj) {
  const canonical = JSON.stringify(obj, (key, val) => {
    if (val === null || val === undefined) return undefined;
    return val;
  }, 0, (k, v) => v); // no replacer sort needed; use below approach
  // Re-serialize with sorted keys
  const sortedCanonical = stableStringify(obj);
  return crypto.createHash('sha256').update(sortedCanonical).digest('hex');
}

/**
 * Stable JSON stringify with sorted keys; null values omitted.
 *
 * @param {*} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const sortedKeys = Object.keys(value).sort();
  const parts = [];
  for (const key of sortedKeys) {
    const v = value[key];
    if (v === null || v === undefined) continue;
    const serialized = stableStringify(v);
    if (serialized !== undefined) {
      parts.push(`${JSON.stringify(key)}:${serialized}`);
    }
  }
  return `{${parts.join(',')}}`;
}

// ─── Manifest management ──────────────────────────────────────────────────────

/**
 * Get the manifest key for db.backupManifests lookup.
 *
 * @param {string} backupPointId
 * @param {string} nodeType
 * @returns {string}
 */
function manifestKey(backupPointId, nodeType) {
  return `${backupPointId}:${nodeType}`;
}

/**
 * Retrieve or build a manifest for a backup point + nodeType.
 * Returns null if no entries exist.
 *
 * @param {string} backupPointId
 * @param {string} nodeType
 * @returns {{ entries: Array<{id: string, contentHash: string}> } | null}
 */
function getManifest(backupPointId, nodeType) {
  return db.backupManifests.get(manifestKey(backupPointId, nodeType)) || null;
}

/**
 * Persist a manifest entry for a backup point + nodeType.
 * Call this during backup ingestion to record the manifest.
 *
 * @param {string} backupPointId
 * @param {string} nodeType
 * @param {Array<{id: string, contentHash: string}>} entries
 */
function saveManifest(backupPointId, nodeType, entries) {
  db.backupManifests.set(manifestKey(backupPointId, nodeType), {
    id: uuidv4(),
    backupPointId,
    nodeType,
    entries,
    computedAt: new Date().toISOString(),
  });
}

// ─── Diff computation ─────────────────────────────────────────────────────────

/**
 * Compare current and prior manifests to derive change indicators.
 *
 * @param {Array<{id: string, contentHash: string}>} currentEntries - Entries in current manifest
 * @param {Array<{id: string, contentHash: string}>|null} priorEntries - Entries in prior manifest (null = first backup)
 * @returns {Map<string, 'Added'|'Modified'|'Unchanged'|'Deleted'>}
 */
function computeChangeMap(currentEntries, priorEntries) {
  const changeMap = new Map();

  const priorMap = new Map();
  if (priorEntries) {
    for (const entry of priorEntries) {
      priorMap.set(entry.id, entry.contentHash);
    }
  }

  // Process current entries
  for (const entry of currentEntries) {
    if (!priorMap.has(entry.id)) {
      changeMap.set(entry.id, 'Added');
    } else if (priorMap.get(entry.id) !== entry.contentHash) {
      changeMap.set(entry.id, 'Modified');
    } else {
      changeMap.set(entry.id, 'Unchanged');
    }
  }

  // Process deleted entries (in prior but not in current)
  const currentIds = new Set(currentEntries.map(e => e.id));
  if (priorEntries) {
    for (const entry of priorEntries) {
      if (!currentIds.has(entry.id)) {
        changeMap.set(entry.id, 'Deleted');
      }
    }
  }

  return changeMap;
}

/**
 * Compute the changed field names between two field objects.
 *
 * @param {object} fields
 * @param {object|null} priorFields
 * @returns {string[]}
 */
function computeChangedFields(fields, priorFields) {
  if (!priorFields || !fields) return [];
  const allKeys = new Set([...Object.keys(fields), ...Object.keys(priorFields)]);
  const changed = [];
  for (const key of allKeys) {
    if (JSON.stringify(fields[key]) !== JSON.stringify(priorFields[key])) {
      changed.push(key);
    }
  }
  return changed.sort();
}

/**
 * Run the Object Explorer diff for a backup point and node type.
 *
 * @param {string} backupPointId
 * @param {string} nodeType
 * @param {string[]} changeIndicatorFilter - Array of indicator values to include
 * @param {string|undefined} parentId - Optional parent scope filter
 * @param {number} limit
 * @param {string|undefined} cursor
 * @returns {{
 *   backupPointId: string,
 *   priorBackupPointId: string|null,
 *   results: object[],
 *   total: number,
 *   nextCursor: string|null
 * }}
 */
function runObjectExplorerDiff(backupPointId, nodeType, changeIndicatorFilter, parentId, limit, cursor) {
  const backupPoint = db.backupPoints.get(backupPointId);
  if (!backupPoint) {
    const err = new Error('Backup point not found');
    err.code = 'BACKUP_POINT_NOT_FOUND';
    throw err;
  }

  const priorBackupPointId = backupPoint.priorBackupPointId || null;

  // Fetch manifests
  const currentManifest = getManifest(backupPointId, nodeType);
  const priorManifest = priorBackupPointId ? getManifest(priorBackupPointId, nodeType) : null;

  const currentEntries = currentManifest ? currentManifest.entries : [];
  const priorEntries = priorManifest ? priorManifest.entries : null;

  // Compute change map
  const changeMap = computeChangeMap(currentEntries, priorEntries || []);

  // Build result items
  const filterSet = new Set(changeIndicatorFilter);
  const allItems = [];

  for (const [id, indicator] of changeMap.entries()) {
    if (!filterSet.has(indicator)) continue;

    // Load fields from current or prior snapshot
    let fields = null;
    let priorFields = null;

    if (indicator === 'Deleted') {
      // Deleted objects: load last-known fields from prior snapshot
      const priorKey = `${priorBackupPointId}:${nodeType}:${id}`;
      const priorSnapshot = db.objectSnapshots.get(priorKey);
      fields = priorSnapshot ? priorSnapshot.fields : {};
      priorFields = fields;
    } else {
      const currentKey = `${backupPointId}:${nodeType}:${id}`;
      const currentSnapshot = db.objectSnapshots.get(currentKey);
      fields = currentSnapshot ? currentSnapshot.fields : {};

      if (indicator === 'Modified') {
        const priorKey = `${priorBackupPointId}:${nodeType}:${id}`;
        const priorSnapshot = db.objectSnapshots.get(priorKey);
        priorFields = priorSnapshot ? priorSnapshot.fields : null;
      } else {
        // Added or Unchanged
        priorFields = null;
      }
    }

    // Apply parentId filter if specified
    if (parentId) {
      const parentFields = fields || {};
      const matchesParent =
        parentFields.projectId === parentId ||
        parentFields.issueId === parentId ||
        parentFields.boardId === parentId ||
        parentFields.fieldId === parentId;
      if (!matchesParent) continue;
    }

    const changedFields =
      indicator === 'Modified' ? computeChangedFields(fields, priorFields) : [];

    allItems.push({
      id,
      nodeType,
      changeIndicator: indicator,
      fields: fields || {},
      priorFields: indicator === 'Modified' || indicator === 'Deleted' ? priorFields : null,
      changedFields,
    });
  }

  // Sort by id for stable pagination
  allItems.sort((a, b) => a.id.localeCompare(b.id));

  // Apply cursor pagination
  const { paginateResults } = require('./searchService');
  const { items, nextCursor } = paginateResults(allItems, limit, cursor, item => item.id);

  return {
    backupPointId,
    priorBackupPointId,
    results: items,
    total: allItems.length,
    nextCursor,
  };
}

module.exports = {
  VALID_NODE_TYPES,
  VALID_CHANGE_INDICATORS,
  computeContentHash,
  stableStringify,
  computeChangeMap,
  computeChangedFields,
  getManifest,
  saveManifest,
  runObjectExplorerDiff,
};
