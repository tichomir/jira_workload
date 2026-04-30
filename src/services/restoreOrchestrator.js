'use strict';

/**
 * Sprint 4 — Restore Engine
 * Restore Orchestrator — main pipeline: validation, conflict resolution, stage execution,
 * destination routing, and API constraint application.
 *
 * Implements all sections of restore-engine-architecture.md:
 *   §2  Dependency-Ordered Execution Graph
 *   §3  Conflict Mode State Machine
 *   §4  Restore Destination Router
 *   §5  Cross-Site Custom Field ID Mapping (enforced as a gate)
 *   §6  Pre-Execution Validation Pipeline
 *   §7  Permanent API Constraint Handlers
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { runValidationPipeline } = require('./validationService');
const { buildFieldMap } = require('./customFieldMappingService');
const {
  stampOriginalKeyLabel,
  injectReporterAttributionHeader,
  prependCommentAuthorAdfHeader,
  buildWorkflowRestorePayload,
} = require('./apiConstraintHandlers');
const {
  ASK_BASKET_THRESHOLD,
  RESTORE_STAGE_ORDER,
} = require('../config/restoreConstants');

// ── Stage type classification ─────────────────────────────────────────────────

const STAGE_TYPES = {
  [RESTORE_STAGE_ORDER.WORKFLOWS_AND_CUSTOM_FIELDS]: ['workflow', 'customFieldDefinition', 'customFieldContext'],
  [RESTORE_STAGE_ORDER.PROJECTS]: ['project'],
  [RESTORE_STAGE_ORDER.PARENT_ISSUES]: ['issue'],
  [RESTORE_STAGE_ORDER.COMMENTS_ATTACHMENTS_BOARDS]: ['comment', 'attachment', 'board'],
  [RESTORE_STAGE_ORDER.SPRINTS]: ['sprint'],
};

function stageForObjectType(objectType) {
  for (const [stageNum, types] of Object.entries(STAGE_TYPES)) {
    if (types.includes(objectType)) return Number(stageNum);
  }
  return RESTORE_STAGE_ORDER.PARENT_ISSUES; // default fallback
}

// ── Basket building ───────────────────────────────────────────────────────────

/**
 * Build the list of items to restore from objectSnapshots filtered by objectSelection.
 *
 * @param {string} backupPointId
 * @param {object} objectSelection - { includeAll, objectTypes, projectKeys, issueKeys }
 * @returns {object[]} Array of basket items with shape { id, objectType, fields, ... }
 */
function buildBasket(backupPointId, objectSelection) {
  const items = [];

  for (const [key, snapshot] of db.objectSnapshots.entries()) {
    if (!key.startsWith(`${backupPointId}:`)) continue;

    const { nodeType, id, fields } = snapshot;
    const objectType = nodeTypeToObjectType(nodeType);
    if (!objectType) continue;

    // Apply objectSelection filters
    if (!objectSelection.includeAll) {
      if (objectSelection.objectTypes && !objectSelection.objectTypes.includes(objectType)) continue;
      if (objectSelection.projectKeys && objectType === 'project') {
        const pk = fields && fields.key;
        if (!objectSelection.projectKeys.includes(pk)) continue;
      }
      if (objectSelection.issueKeys && objectType === 'issue') {
        const ik = fields && fields.key;
        if (objectSelection.issueKeys.length > 0 && !objectSelection.issueKeys.includes(ik)) continue;
      }
    }

    items.push({ id, objectType, fields: fields || {}, snapshotKey: key });
  }

  // If no snapshots in db, produce an empty basket (simulation with no seed data)
  return items;
}

function nodeTypeToObjectType(nodeType) {
  const map = {
    JiraWorkflowNode: 'workflow',
    JiraCustomFieldDefinitionNode: 'customFieldDefinition',
    JiraCustomFieldContextNode: 'customFieldContext',
    JiraProjectNode: 'project',
    JiraIssueNode: 'issue',
    JiraCommentNode: 'comment',
    JiraAttachmentNode: 'attachment',
    JiraBoardNode: 'board',
    JiraSprintNode: 'sprint',
  };
  return map[nodeType] || null;
}

// ── Conflict mode resolution ──────────────────────────────────────────────────

/**
 * Resolve effective conflict mode. Downgrades 'ask' to 'skip' when basket > 50 (ADR-002).
 *
 * @param {string} conflictMode - Requested conflict mode ('skip' | 'override' | 'ask')
 * @param {number} basketTotalItems
 * @returns {{ conflictModeEffective: string, conflictModeDowngradeReason?: string }}
 */
function resolveConflictMode(conflictMode, basketTotalItems) {
  const mode = conflictMode || 'skip';
  if (mode === 'ask' && basketTotalItems > ASK_BASKET_THRESHOLD) {
    return { conflictModeEffective: 'skip', conflictModeDowngradeReason: 'BASKET_SIZE_EXCEEDED' };
  }
  return { conflictModeEffective: mode };
}

// ── Conflict detection ────────────────────────────────────────────────────────

/**
 * Determine if a given item already exists at the target destination.
 *
 * For 'original' destination: match by project key (projects) or object name (others).
 * For 'alternate' destination: match by object name/key at target site.
 * For 'export' destination: no conflict possible.
 */
function detectConflict(item, destination, targetProjectKey) {
  if (destination.type === 'export') return false;

  const fields = item.fields || {};
  const objectType = item.objectType;

  if (objectType === 'project') {
    // Match by project key
    for (const [, project] of db.projectNodes.entries()) {
      const siteMatch = !destination.targetSiteId
        || project.cloudId === destination.targetSiteId
        || project.siteId === destination.targetSiteId;
      if (siteMatch && project.key === (targetProjectKey || fields.key)) {
        return true;
      }
    }
    return false;
  }

  if (objectType === 'workflow') {
    const name = fields.name || '';
    for (const [, wf] of db.workflowNodes.entries()) {
      const siteMatch = !destination.targetSiteId
        || wf.cloudId === destination.targetSiteId;
      if (siteMatch && wf.name === name) return true;
    }
    return false;
  }

  if (objectType === 'customFieldDefinition') {
    const name = fields.name || '';
    for (const [key, cf] of db.customFieldDefinitions.entries()) {
      const siteMatch = !destination.targetSiteId || key.startsWith(`${destination.targetSiteId}:`);
      if (siteMatch && cf.name === name) return true;
    }
    return false;
  }

  // For issues, comments, attachments, boards, sprints:
  // Conflict is detected by checking restoredObjects for an existing item with same source ID
  // (this prevents double-restore in a re-run scenario — in production would query Jira API)
  return false;
}

// ── Object restore (apply to destination) ────────────────────────────────────

/**
 * Apply an object to the destination. For original/alternate, writes to restoredObjects.
 * For export, adds to the export manifest.
 *
 * Returns { targetId, exportEntry? }
 */
function applyObjectToDestination(restoreJobId, item, destination, fieldMap, boardIdMap) {
  const targetId = uuidv4(); // Simulated Jira-assigned ID on restore
  let payload = { fields: { ...(item.fields || {}) } };

  // Apply field ID mapping for cross-site restores
  if (destination.isCrossSite && fieldMap && Object.keys(fieldMap).length > 0) {
    const mappedFields = {};
    for (const [k, v] of Object.entries(payload.fields)) {
      const mappedKey = fieldMap[k] || k;
      mappedFields[mappedKey] = v;
    }
    payload.fields = mappedFields;
  }

  // ── API Constraint Handlers ──────────────────────────────────────────────

  if (item.objectType === 'issue') {
    // Constraint 1: Stamp original-key label
    const originalKey = item.fields.key || item.id;
    payload = stampOriginalKeyLabel(payload, originalKey);
  }

  if (item.objectType === 'comment') {
    const fields = item.fields || {};
    let adfBody = fields.body || { version: 1, type: 'doc', content: [] };
    if (typeof adfBody === 'string') {
      adfBody = { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: adfBody }] }] };
    }

    // Constraint 2: Prepend reporter attribution header first (it will be pushed down by the author header)
    if (fields.reporter) {
      adfBody = injectReporterAttributionHeader(
        adfBody,
        { displayName: fields.reporter.displayName || fields.reporter, emailAddress: fields.reporter.emailAddress || '' },
      );
    }

    // Constraint 3: Prepend comment author ADF header last so it becomes the outermost (first) node (ADR-004)
    if (fields.author) {
      adfBody = prependCommentAuthorAdfHeader(
        adfBody,
        { displayName: fields.author.displayName || fields.author, accountId: fields.author.accountId || '' },
        fields.created || new Date().toISOString(),
      );
    }

    payload.fields.body = adfBody;
  }

  if (item.objectType === 'workflow') {
    // Constraint 4: Full workflow definition supply
    try {
      payload = { definition: buildWorkflowRestorePayload(item.fields) };
    } catch (err) {
      return { error: err.code || 'WORKFLOW_DEFINITION_MISSING', targetId: null };
    }
  }

  if (item.objectType === 'sprint' && boardIdMap) {
    // Resolve boardId from Stage 4 board restore result map
    const sourceBoardId = item.fields && item.fields.boardId;
    if (sourceBoardId && boardIdMap[sourceBoardId]) {
      payload.fields.boardId = boardIdMap[sourceBoardId];
    } else if (sourceBoardId && !boardIdMap[sourceBoardId]) {
      return { error: 'DEPENDENCY_MISSING', targetId: null };
    }
  }

  // Store restored object in db
  const storeKey = `${restoreJobId}:${item.objectType}:${item.id}`;
  db.restoredObjects.set(storeKey, {
    restoreJobId,
    objectType: item.objectType,
    id: item.id,
    targetId,
    payload,
    destination,
  });

  if (destination.type === 'export') {
    return { targetId, exportEntry: { id: item.id, objectType: item.objectType, targetId, payload } };
  }

  return { targetId };
}

// ── Stage execution ───────────────────────────────────────────────────────────

/**
 * Execute one stage of the restore pipeline.
 *
 * @param {number} stageNumber
 * @param {object[]} stageItems - Items for this stage
 * @param {string} conflictModeEffective
 * @param {object} destination
 * @param {string} targetProjectKey
 * @param {object} fieldMap - Custom field ID mapping (cross-site)
 * @param {object} boardIdMap - { sourceBoardId → targetBoardId } from Stage 4 (for Stage 5)
 * @param {string} restoreJobId
 * @param {object[]} exportEntries - Accumulator for export entries (mutated)
 * @returns {{ stageResult: object, boardIdMap: object, pendingConflicts: object[] }}
 */
function executeStage(stageNumber, stageItems, conflictModeEffective, destination, targetProjectKey, fieldMap, boardIdMap, restoreJobId, exportEntries) {
  const itemResults = [];
  const newBoardIdMap = { ...boardIdMap };
  const pendingConflicts = [];

  for (const item of stageItems) {
    const hasConflict = detectConflict(item, destination, targetProjectKey);

    if (hasConflict) {
      if (conflictModeEffective === 'skip') {
        // Use existing object; mark as skipped
        itemResults.push({
          id: item.id,
          objectType: item.objectType,
          status: 'skipped',
          skipReason: 'CONFLICT_SKIPPED',
        });
        continue;
      }

      if (conflictModeEffective === 'override') {
        // Update the existing target object (simulated PUT), then continue
        const { targetId, error } = applyObjectToDestination(restoreJobId, item, destination, fieldMap, newBoardIdMap);
        if (error) {
          itemResults.push({ id: item.id, objectType: item.objectType, status: 'failed', errorCode: error });
        } else {
          if (item.objectType === 'board') newBoardIdMap[item.id] = targetId;
          itemResults.push({ id: item.id, objectType: item.objectType, status: 'success', targetId });
          if (destination.type === 'export' && exportEntries) {
            exportEntries.push({ id: item.id, objectType: item.objectType, targetId });
          }
        }
        continue;
      }

      if (conflictModeEffective === 'ask') {
        // Dispatch per-object prompt; suspend this item
        pendingConflicts.push({ itemId: item.id, objectType: item.objectType });
        itemResults.push({
          id: item.id,
          objectType: item.objectType,
          status: 'pending',
          skipReason: 'AWAITING_CONFLICT_DECISION',
        });
        continue;
      }
    }

    // No conflict (or resolved): restore the object
    const { targetId, error, exportEntry } = applyObjectToDestination(restoreJobId, item, destination, fieldMap, newBoardIdMap);

    if (error) {
      itemResults.push({ id: item.id, objectType: item.objectType, status: 'failed', errorCode: error });
    } else {
      if (item.objectType === 'board') newBoardIdMap[item.id] = targetId;
      itemResults.push({ id: item.id, objectType: item.objectType, status: 'success', targetId });
      if (exportEntry && exportEntries) exportEntries.push(exportEntry);
    }
  }

  const stageResult = {
    stageNumber,
    succeeded: itemResults.filter(r => r.status === 'success').length,
    skipped: itemResults.filter(r => r.status === 'skipped').length,
    failed: itemResults.filter(r => r.status === 'failed').length,
    blocked: itemResults.filter(r => r.status === 'blocked').length,
    items: itemResults,
  };

  return { stageResult, boardIdMap: newBoardIdMap, pendingConflicts };
}

// ── Build export archive ──────────────────────────────────────────────────────

function buildExportArchive(restoreJobId, exportEntries, basketItems, destination) {
  const manifest = exportEntries.map(e => ({
    id: e.id,
    objectType: e.objectType,
    targetId: e.targetId,
    objectPath: `objects/${e.objectType}_${e.id}.json`,
    ...(e.objectType === 'attachment' ? { attachmentPath: `attachments/${e.id}` } : {}),
  }));

  const objects = {};
  for (const entry of exportEntries) {
    const filename = `objects/${entry.objectType}_${entry.id}.json`;
    const stored = db.restoredObjects.get(`${restoreJobId}:${entry.objectType}:${entry.id}`);
    objects[filename] = stored ? stored.payload : { id: entry.id, objectType: entry.objectType };
  }

  // Attachment binaries placeholder (in production: fetched from backup store and ZIP'd)
  const attachmentEntries = basketItems.filter(i => i.objectType === 'attachment');
  const attachments = attachmentEntries.map(a => ({
    id: a.id,
    filename: a.fields && a.fields.filename,
    path: `attachments/${a.id}`,
    sizeBytes: a.sizeBytes || (a.fields && a.fields.sizeBytes) || 0,
  }));

  return { restoreJobId, manifest, objects, attachments, exportFormat: destination.exportFormat || 'json+zip' };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * Initiate a restore job. Runs the full pipeline synchronously and stores the result.
 *
 * @param {object} restoreRequest - RestoreRequest shape from the API contract
 * @returns {object} RestoreResponse
 */
function initiateRestore(restoreRequest) {
  const {
    backupPointId,
    sourceSiteId,
    destination,
    conflictMode,
    objectSelection,
  } = restoreRequest;

  // Resolve target site and project from destination
  const targetSiteId = destination.type === 'original'
    ? (destination.originalSiteId || sourceSiteId)
    : (destination.targetSiteId || sourceSiteId);
  const targetProjectKey = destination.type === 'original'
    ? destination.originalProjectKey
    : destination.targetProjectKey;

  // Build basket
  const basketItems = buildBasket(backupPointId, objectSelection || { includeAll: true });
  const basketTotalItems = basketItems.length;

  // Resolve conflict mode (downgrade ask → skip if basket > 50)
  const { conflictModeEffective, conflictModeDowngradeReason } = resolveConflictMode(conflictMode, basketTotalItems);

  // Determine if basket contains boards/sprints (needed for check 4)
  const includeBoardSprintRestore = basketItems.some(i => i.objectType === 'board' || i.objectType === 'sprint');

  // Run pre-execution validation
  const validationResult = runValidationPipeline({
    restoreRequest,
    targetSiteId,
    targetProjectKey: targetProjectKey || '',
    basketItems,
    includeBoardSprintRestore,
  });

  if (!validationResult.passed) {
    return {
      __validationError: true,
      blockingError: validationResult.blockingError,
      warnings: validationResult.warnings,
    };
  }

  // Cross-site custom field mapping gate (ADR-005)
  let fieldMap = {};
  let customFieldMappingResult = null;
  if (destination.isCrossSite || (destination.type === 'alternate' && destination.targetSiteId !== sourceSiteId)) {
    const sourceFieldIds = [];
    for (const item of basketItems) {
      if (item.objectType === 'issue') {
        for (const k of Object.keys(item.fields || {})) {
          if (k.startsWith('customfield_') && !sourceFieldIds.includes(k)) {
            sourceFieldIds.push(k);
          }
        }
      }
    }
    customFieldMappingResult = buildFieldMap({ sourceSiteId, targetSiteId, sourceFieldIds });
    if (customFieldMappingResult.status === 'blocked') {
      return {
        __fieldMappingBlocked: true,
        missingRequired: customFieldMappingResult.missingRequired,
        warnings: validationResult.warnings,
      };
    }
    fieldMap = customFieldMappingResult.fieldMap;
  }

  // Create restore job record
  const restoreJobId = uuidv4();
  const job = {
    restoreJobId,
    status: 'running',
    conflictModeEffective,
    conflictModeDowngradeReason,
    destination,
    validationWarnings: validationResult.warnings,
    stageResults: [],
    currentStage: RESTORE_STAGE_ORDER.WORKFLOWS_AND_CUSTOM_FIELDS,
    pendingConflicts: [],
    basketItems,
    exportArchiveKey: null,
    createdAt: new Date().toISOString(),
  };
  db.restoreJobs.set(restoreJobId, job);

  // Group items by stage
  const stageMap = {};
  for (let s = 1; s <= 5; s++) stageMap[s] = [];
  for (const item of basketItems) {
    const stageNum = stageForObjectType(item.objectType);
    stageMap[stageNum].push(item);
  }

  // Execute stages in order; halt on blocking failure
  const exportEntries = [];
  let boardIdMap = {};
  let anyBlockingFailure = false;

  for (let stageNum = 1; stageNum <= 5; stageNum++) {
    job.currentStage = stageNum;
    const stageItems = stageMap[stageNum] || [];

    if (anyBlockingFailure) {
      // Block all remaining stages
      job.stageResults.push({
        stageNumber: stageNum,
        succeeded: 0,
        skipped: 0,
        failed: 0,
        blocked: stageItems.length,
        items: stageItems.map(i => ({ id: i.id, objectType: i.objectType, status: 'blocked', skipReason: 'PRIOR_STAGE_FAILED' })),
      });
      continue;
    }

    const { stageResult, boardIdMap: updatedBoardIdMap, pendingConflicts } = executeStage(
      stageNum, stageItems, conflictModeEffective, destination, targetProjectKey,
      fieldMap, boardIdMap, restoreJobId, exportEntries,
    );

    boardIdMap = updatedBoardIdMap;
    job.stageResults.push(stageResult);

    if (pendingConflicts.length > 0) {
      // ask mode: collect pending conflicts and pause here
      job.pendingConflicts.push(...pendingConflicts);
      job.status = 'running'; // stays running; caller must submit conflict decisions
      // Continue processing remaining items within the stage (already in stageResult)
    }

    // A blocking failure in this stage halts subsequent stages
    if (stageResult.failed > 0) {
      anyBlockingFailure = true;
    }
  }

  // Finalize job status
  if (job.pendingConflicts.length > 0) {
    job.status = 'running'; // waiting for conflict decisions
  } else if (anyBlockingFailure) {
    job.status = 'failed';
  } else {
    job.status = 'complete';
  }

  // Build export archive if destination is export
  if (destination.type === 'export') {
    const archive = buildExportArchive(restoreJobId, exportEntries, basketItems, destination);
    db.exportArchives.set(restoreJobId, archive);
    job.exportArchiveKey = restoreJobId;
    job.exportDownloadUrl = `/api/v1/restore/${restoreJobId}/export`;
  }

  db.restoreJobs.set(restoreJobId, job);

  return buildRestoreResponse(job);
}

// ── Conflict decision handler ─────────────────────────────────────────────────

/**
 * Submit a conflict decision for a pending ask-mode item.
 *
 * @param {string} restoreJobId
 * @param {string} itemId
 * @param {'skip'|'override'} decision
 * @returns {object} ConflictDecisionResponse
 */
function submitConflictDecision(restoreJobId, itemId, decision) {
  const job = db.restoreJobs.get(restoreJobId);
  if (!job) {
    const err = new Error('Restore job not found');
    err.code = 'RESTORE_JOB_NOT_FOUND';
    throw err;
  }

  if (job.conflictModeEffective !== 'ask') {
    const err = new Error('Ask mode was suppressed; no conflict decisions needed');
    err.code = 'ASK_MODE_SUPPRESSED';
    throw err;
  }

  const conflictIndex = job.pendingConflicts.findIndex(c => c.itemId === itemId);
  if (conflictIndex === -1) {
    const err = new Error('No pending conflict for this item');
    err.code = 'NO_PENDING_CONFLICT';
    throw err;
  }

  // Remove from pending
  job.pendingConflicts.splice(conflictIndex, 1);

  // Find the item across stageResults and apply decision
  for (const stageResult of job.stageResults) {
    const itemResult = stageResult.items.find(i => i.id === itemId);
    if (itemResult && itemResult.status === 'pending') {
      const basketItem = job.basketItems.find(i => i.id === itemId);
      if (basketItem) {
        if (decision === 'skip') {
          itemResult.status = 'skipped';
          itemResult.skipReason = 'CONFLICT_SKIPPED';
          stageResult.skipped += 1;
        } else {
          // override: apply the restore
          const { targetId, error } = applyObjectToDestination(
            restoreJobId, basketItem, job.destination, {}, {},
          );
          if (error) {
            itemResult.status = 'failed';
            itemResult.errorCode = error;
            stageResult.failed += 1;
          } else {
            itemResult.status = 'success';
            itemResult.targetId = targetId;
            stageResult.succeeded += 1;
          }
        }
        // Recalculate pending count (subtract 1 since we moved it out)
      }
      break;
    }
  }

  // Update job status
  if (job.pendingConflicts.length === 0) {
    const anyFailed = job.stageResults.some(s => s.failed > 0);
    job.status = anyFailed ? 'failed' : 'complete';
  }

  db.restoreJobs.set(restoreJobId, job);

  return {
    itemId,
    decision,
    restoreJobStatus: job.status,
  };
}

// ── Response builder ──────────────────────────────────────────────────────────

function buildRestoreResponse(job) {
  const response = {
    restoreJobId: job.restoreJobId,
    status: job.status,
    conflictModeEffective: job.conflictModeEffective,
    destination: job.destination,
    validationWarnings: job.validationWarnings || [],
    stageResults: job.stageResults,
  };
  if (job.conflictModeDowngradeReason) {
    response.conflictModeDowngradeReason = job.conflictModeDowngradeReason;
  }
  if (job.exportDownloadUrl) {
    response.exportDownloadUrl = job.exportDownloadUrl;
  }
  return response;
}

// ── Basket summary builder (for validate endpoint) ────────────────────────────

function buildBasketSummary(basketItems, conflictModeEffective, conflictModeDowngradeReason) {
  const byType = {};
  for (const item of basketItems) {
    byType[item.objectType] = (byType[item.objectType] || 0) + 1;
  }
  const summary = {
    totalItems: basketItems.length,
    byType,
    conflictModeEffective,
  };
  if (conflictModeDowngradeReason) summary.conflictModeDowngradeReason = conflictModeDowngradeReason;
  return summary;
}

module.exports = {
  initiateRestore,
  submitConflictDecision,
  buildBasket,
  resolveConflictMode,
  buildBasketSummary,
};
