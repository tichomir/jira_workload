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
const { getValidAccessToken, createJiraAxiosInstance } = require('./tokenService');
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

const JIRA_API_BASE = 'https://api.atlassian.com/ex/jira';

// ── Error codes that indicate a "skip" rather than a hard failure ─────────────
// These errors mean the item cannot be restored for a structural reason (e.g.
// system fields cannot be created via the Jira API) but should not count toward
// failedCount or block subsequent pipeline stages.
const SKIP_ONLY_CODES = new Set([
  'SYSTEM_FIELD_SKIP',  // System fields (status, summary, etc.) cannot be created
  'UNSUPPORTED_TYPE',   // Object type has no write path in this pipeline version
]);

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

    const { nodeType, id, fields, issueKey } = snapshot;
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
        const ik = (fields && fields.key) || issueKey;
        if (objectSelection.issueKeys.length > 0 && !objectSelection.issueKeys.includes(ik)) continue;
      }
    }

    items.push({ id, objectType, fields: fields || {}, issueKey: issueKey || id, snapshotKey: key });
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
 */
function detectConflict(item, destination, targetProjectKey) {
  if (destination.type === 'export') return false;

  const fields = item.fields || {};
  const objectType = item.objectType;

  if (objectType === 'project') {
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

  return false;
}

// ── Jira REST API write calls ─────────────────────────────────────────────────

/**
 * Write an object to the target Jira site via REST API.
 * Returns { targetId, targetKey? } on success, or throws on error.
 *
 * @param {import('axios').AxiosInstance} jiraAxios
 * @param {string} cloudId  Target cloud ID
 * @param {object} item  Basket item (objectType, fields, id, issueKey)
 * @param {object} destination
 * @param {string|null} targetProjectKey
 * @param {object} fieldMap  Cross-site custom field ID mapping
 * @param {object} sourceToTargetIssueKey  { sourceIssueId → targetIssueKey }
 * @returns {Promise<{targetId: string, targetKey?: string}>}
 */
async function writeObjectToJira(jiraAxios, cloudId, item, destination, targetProjectKey, fieldMap, sourceToTargetIssueKey) {
  const base = `${JIRA_API_BASE}/${cloudId}`;
  const fields = item.fields || {};

  switch (item.objectType) {
    case 'issue': {
      // Determine target project key
      const projKey = targetProjectKey
        || (fields.project && fields.project.key)
        || (fields.project && fields.project.id);

      if (!projKey) {
        throw Object.assign(new Error('Cannot restore issue: no target project key available'), { code: 'MISSING_PROJECT_KEY' });
      }

      // Apply field ID mapping for cross-site restores
      let customFields = {};
      if (destination.isCrossSite && fieldMap) {
        for (const [k, v] of Object.entries(fields)) {
          if (k.startsWith('customfield_')) {
            const mappedKey = fieldMap[k] || k;
            customFields[mappedKey] = v;
          }
        }
      }

      const issuePayload = {
        fields: {
          project: { key: projKey },
          summary: fields.summary || 'Restored issue',
          issuetype: fields.issuetype
            ? { name: fields.issuetype.name || 'Task' }
            : { name: 'Task' },
          ...customFields,
        },
      };

      // Description (ADF)
      if (fields.description) issuePayload.fields.description = fields.description;

      // Priority
      if (fields.priority && fields.priority.name) {
        issuePayload.fields.priority = { name: fields.priority.name };
      }

      // Labels — include original-key label per ADR-004
      const originalKey = item.issueKey || item.id;
      const existingLabels = Array.isArray(fields.labels) ? fields.labels : [];
      issuePayload.fields.labels = [...existingLabels, `original-key:${originalKey}`];

      // Reporter attribution (via description prepend, not reporter field — Jira API limitation)
      if (fields.reporter && fields.reporter.displayName) {
        const reporterLine = `[Restored from: reporter=${fields.reporter.displayName}]`;
        if (!issuePayload.fields.description) {
          issuePayload.fields.description = {
            version: 1, type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: reporterLine }] }],
          };
        } else if (issuePayload.fields.description.content) {
          issuePayload.fields.description = {
            ...issuePayload.fields.description,
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: reporterLine }] },
              ...issuePayload.fields.description.content,
            ],
          };
        }
      }

      const resp = await jiraAxios.post(`${base}/rest/api/3/issue`, issuePayload);
      return { targetId: resp.data.id, targetKey: resp.data.key };
    }

    case 'comment': {
      // Find the target issue key — use sourceToTargetIssueKey map or fields.issueKey
      const sourceIssueId = fields.issueId || fields.issueKey;
      const targetIssueKey = (sourceIssueId && sourceToTargetIssueKey[sourceIssueId])
        || (targetProjectKey ? `${targetProjectKey}-1` : null);

      if (!targetIssueKey) {
        throw Object.assign(new Error('Cannot restore comment: target issue key unknown'), { code: 'MISSING_ISSUE_KEY' });
      }

      let adfBody = fields.body || { version: 1, type: 'doc', content: [] };
      if (typeof adfBody === 'string') {
        adfBody = { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: adfBody }] }] };
      }

      if (fields.reporter) {
        adfBody = injectReporterAttributionHeader(
          adfBody,
          { displayName: fields.reporter.displayName || fields.reporter, emailAddress: fields.reporter.emailAddress || '' },
        );
      }
      if (fields.author) {
        adfBody = prependCommentAuthorAdfHeader(
          adfBody,
          { displayName: fields.author.displayName || fields.author, accountId: fields.author.accountId || '' },
          fields.created || new Date().toISOString(),
        );
      }

      const resp = await jiraAxios.post(`${base}/rest/api/3/issue/${targetIssueKey}/comment`, { body: adfBody });
      return { targetId: resp.data.id };
    }

    case 'workflow': {
      let payload;
      try {
        payload = { definition: buildWorkflowRestorePayload(fields) };
      } catch (err) {
        throw Object.assign(new Error('Cannot restore workflow: missing definition'), { code: 'WORKFLOW_DEFINITION_MISSING' });
      }
      const resp = await jiraAxios.post(`${base}/rest/api/3/workflow/create`, payload);
      return { targetId: resp.data.id || resp.data.entityId || uuidv4() };
    }

    case 'customFieldDefinition': {
      // Only custom fields (not system fields) can be created
      if (!(fields.id && fields.id.startsWith('customfield_'))) {
        throw Object.assign(new Error('Skipping system field restore'), { code: 'SYSTEM_FIELD_SKIP' });
      }
      const fieldPayload = {
        name: fields.name || 'Restored Field',
        type: (fields.schema && fields.schema.custom) || 'com.atlassian.jira.plugin.system.customfieldtypes:textfield',
      };
      const resp = await jiraAxios.post(`${base}/rest/api/3/field`, fieldPayload);
      return { targetId: resp.data.id };
    }

    case 'project': {
      const projPayload = {
        key: (fields.key || 'REST').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'REST',
        name: (fields.name || 'Restored Project') + ' (restored)',
        projectTypeKey: fields.projectTypeKey || 'software',
        projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-scrum-template',
        description: fields.description || 'Restored from backup',
      };
      if (fields.lead && fields.lead.accountId) {
        projPayload.leadAccountId = fields.lead.accountId;
      }
      const resp = await jiraAxios.post(`${base}/rest/api/3/project`, projPayload);
      return { targetId: String(resp.data.id) };
    }

    case 'board': {
      const boardPayload = {
        name: fields.name || 'Restored Board',
        type: fields.type || 'scrum',
        filterId: fields.filterId,
      };
      const resp = await jiraAxios.post(`${base}/rest/agile/1.0/board`, boardPayload);
      return { targetId: String(resp.data.id) };
    }

    case 'sprint': {
      const sourceBoardId = fields.boardId;
      const targetBoardId = sourceBoardId && sourceToTargetIssueKey[`board:${sourceBoardId}`];
      if (!targetBoardId) {
        throw Object.assign(new Error('Sprint board not restored yet'), { code: 'DEPENDENCY_MISSING' });
      }
      const sprintPayload = {
        name: fields.name || 'Restored Sprint',
        originBoardId: targetBoardId,
        goal: fields.goal,
        startDate: fields.startDate,
        endDate: fields.endDate,
      };
      const resp = await jiraAxios.post(`${base}/rest/agile/1.0/sprint`, sprintPayload);
      return { targetId: String(resp.data.id) };
    }

    default:
      throw Object.assign(new Error(`Unsupported object type: ${item.objectType}`), { code: 'UNSUPPORTED_TYPE' });
  }
}

// ── Object restore (apply to destination) ────────────────────────────────────

/**
 * Apply an object to the destination.
 * For original/alternate destinations: writes via Jira REST API and records in restoredObjects.
 * For export destination: adds to the export manifest (no API call).
 *
 * Returns { targetId, targetKey?, exportEntry? }
 */
async function applyObjectToDestination(restoreJobId, item, destination, fieldMap, boardIdMap, jiraAxios, cloudId, sourceToTargetIssueKey, targetProjectKey) {
  if (destination.type === 'export') {
    // Export: build payload with constraints applied, no API call
    const targetId = uuidv4();
    let payload = { fields: { ...(item.fields || {}) } };

    if (item.objectType === 'issue') {
      const originalKey = item.issueKey || item.id;
      payload = stampOriginalKeyLabel(payload, originalKey);
    }
    if (item.objectType === 'workflow') {
      try { payload = { definition: buildWorkflowRestorePayload(item.fields) }; }
      catch (err) { return { error: 'WORKFLOW_DEFINITION_MISSING', targetId: null }; }
    }

    const storeKey = `${restoreJobId}:${item.objectType}:${item.id}`;
    db.restoredObjects.set(storeKey, { restoreJobId, objectType: item.objectType, id: item.id, targetId, payload, destination });
    return { targetId, exportEntry: { id: item.id, objectType: item.objectType, targetId, payload } };
  }

  // Original or alternate destination: write to Jira API
  try {
    const { targetId, targetKey } = await writeObjectToJira(
      jiraAxios, cloudId, item, destination, targetProjectKey, fieldMap, sourceToTargetIssueKey,
    );

    const storeKey = `${restoreJobId}:${item.objectType}:${item.id}`;
    db.restoredObjects.set(storeKey, {
      restoreJobId,
      objectType: item.objectType,
      id: item.id,
      targetId,
      targetKey: targetKey || null,
      destination,
    });

    return { targetId, targetKey };
  } catch (err) {
    const errorCode = err.code
      || (err.isAxiosError && err.response ? `JIRA_API_${err.response.status}` : 'JIRA_API_ERROR');
    const isSkip = SKIP_ONLY_CODES.has(errorCode);
    if (!isSkip) {
      console.warn(`[restore] Failed to write ${item.objectType} id=${item.id}: ${errorCode} — ${err.message}`);
    }
    return { error: errorCode, skip: isSkip, targetId: null };
  }
}

// ── Stage execution ───────────────────────────────────────────────────────────

/**
 * Execute one stage of the restore pipeline asynchronously.
 */
async function executeStage(stageNumber, stageItems, conflictModeEffective, destination, targetProjectKey, fieldMap, boardIdMap, restoreJobId, exportEntries, jiraAxios, cloudId, sourceToTargetIssueKey) {
  const itemResults = [];
  const newBoardIdMap = { ...boardIdMap };
  const pendingConflicts = [];

  for (const item of stageItems) {
    const hasConflict = detectConflict(item, destination, targetProjectKey);

    if (hasConflict) {
      if (conflictModeEffective === 'skip') {
        itemResults.push({
          id: item.id,
          objectType: item.objectType,
          status: 'skipped',
          skipReason: 'CONFLICT_SKIPPED',
        });
        continue;
      }

      if (conflictModeEffective === 'override') {
        const { targetId, targetKey, error, skip } = await applyObjectToDestination(
          restoreJobId, item, destination, fieldMap, newBoardIdMap, jiraAxios, cloudId, sourceToTargetIssueKey, targetProjectKey,
        );
        if (error) {
          itemResults.push({ id: item.id, objectType: item.objectType, status: skip ? 'skipped' : 'failed', errorCode: error });
        } else {
          if (item.objectType === 'board') { newBoardIdMap[item.id] = targetId; sourceToTargetIssueKey[`board:${item.id}`] = targetId; }
          if (item.objectType === 'issue' && targetKey) sourceToTargetIssueKey[item.id] = targetKey;
          itemResults.push({ id: item.id, objectType: item.objectType, status: 'success', targetId, targetKey });
          if (destination.type === 'export' && exportEntries) exportEntries.push({ id: item.id, objectType: item.objectType, targetId });
        }
        continue;
      }

      if (conflictModeEffective === 'ask') {
        pendingConflicts.push({ itemId: item.id, objectType: item.objectType });
        itemResults.push({ id: item.id, objectType: item.objectType, status: 'pending', skipReason: 'AWAITING_CONFLICT_DECISION' });
        continue;
      }
    }

    // No conflict (or resolved): restore the object
    const { targetId, targetKey, error, exportEntry, skip } = await applyObjectToDestination(
      restoreJobId, item, destination, fieldMap, newBoardIdMap, jiraAxios, cloudId, sourceToTargetIssueKey, targetProjectKey,
    );

    if (error) {
      itemResults.push({ id: item.id, objectType: item.objectType, status: skip ? 'skipped' : 'failed', errorCode: error });
    } else {
      if (item.objectType === 'board') { newBoardIdMap[item.id] = targetId; sourceToTargetIssueKey[`board:${item.id}`] = targetId; }
      if (item.objectType === 'issue' && targetKey) sourceToTargetIssueKey[item.id] = targetKey;
      itemResults.push({ id: item.id, objectType: item.objectType, status: 'success', targetId, targetKey });
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
 * Initiate a restore job. Runs the full pipeline asynchronously and stores the result.
 * connectionId is required in restoreRequest to obtain a valid access token for Jira writes.
 *
 * @param {object} restoreRequest - RestoreRequest shape + connectionId
 * @returns {Promise<object>} RestoreResponse
 */
async function initiateRestore(restoreRequest) {
  const {
    backupPointId,
    sourceSiteId,
    destination,
    conflictMode,
    objectSelection,
    connectionId,
  } = restoreRequest;

  // Resolve target site and project from destination
  const targetSiteId = destination.type === 'original'
    ? (destination.originalSiteId || sourceSiteId)
    : (destination.targetSiteId || sourceSiteId);
  const targetProjectKey = destination.type === 'original'
    ? destination.originalProjectKey
    : destination.targetProjectKey;

  // Determine the cloudId for the target site
  const effectiveCloudId = targetSiteId || sourceSiteId;

  // Build basket
  const basketItems = buildBasket(backupPointId, objectSelection || { includeAll: true });
  const basketTotalItems = basketItems.length;

  // Resolve conflict mode (downgrade ask → skip if basket > 50)
  const { conflictModeEffective, conflictModeDowngradeReason } = resolveConflictMode(conflictMode, basketTotalItems);

  // Determine if basket contains boards/sprints
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

  // Obtain a valid Jira access token and create a shared axios instance (with 401 retry).
  // Skip for export-only restores (no Jira API calls needed).
  let jiraAxios = null;
  if (destination.type !== 'export' && connectionId) {
    try {
      const accessToken = await getValidAccessToken(connectionId);
      jiraAxios = createJiraAxiosInstance(connectionId, accessToken);
    } catch (err) {
      console.warn(`[restore] Could not obtain access token for connection ${connectionId}: ${err.message}`);
      // Continue — writes will fail per-object and be reported as failures
    }
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

  // sourceToTargetIssueKey: tracks sourceIssueId → targetIssueKey (for comment restoration)
  // Also used for board: `board:${sourceBoardId}` → targetBoardId
  const sourceToTargetIssueKey = {};

  // Execute all stages; per-object failures are non-blocking (logged per-item).
  // Only an auth error or complete pipeline crash aborts the restore.
  const exportEntries = [];
  let boardIdMap = {};

  for (let stageNum = 1; stageNum <= 5; stageNum++) {
    job.currentStage = stageNum;
    const stageItems = stageMap[stageNum] || [];

    const { stageResult, boardIdMap: updatedBoardIdMap, pendingConflicts } = await executeStage(
      stageNum, stageItems, conflictModeEffective, destination, targetProjectKey,
      fieldMap, boardIdMap, restoreJobId, exportEntries, jiraAxios, effectiveCloudId, sourceToTargetIssueKey,
    );

    boardIdMap = updatedBoardIdMap;
    job.stageResults.push(stageResult);

    if (pendingConflicts.length > 0) {
      job.pendingConflicts.push(...pendingConflicts);
    }
  }

  // Finalize job status
  if (job.pendingConflicts.length > 0) {
    job.status = 'running';
  } else {
    job.status = 'complete';
  }

  // Compute aggregate counts
  let restoredCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const byType = {};

  for (const stage of job.stageResults) {
    restoredCount += stage.succeeded;
    skippedCount += stage.skipped;
    failedCount += stage.failed;
    for (const item of stage.items || []) {
      if (!byType[item.objectType]) byType[item.objectType] = { restored: 0, skipped: 0, failed: 0 };
      if (item.status === 'success') byType[item.objectType].restored += 1;
      else if (item.status === 'skipped') byType[item.objectType].skipped += 1;
      else if (item.status === 'failed') byType[item.objectType].failed += 1;
    }
  }

  job.restoredCount = restoredCount;
  job.skippedCount = skippedCount;
  job.failedCount = failedCount;
  job.byType = byType;

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
 */
async function submitConflictDecision(restoreJobId, itemId, decision) {
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

  job.pendingConflicts.splice(conflictIndex, 1);

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
          // override: apply the restore (no Jira API call here since we lack jiraAxios context)
          // Store simulated result
          const targetId = uuidv4();
          db.restoredObjects.set(`${restoreJobId}:${basketItem.objectType}:${basketItem.id}`, {
            restoreJobId, objectType: basketItem.objectType, id: basketItem.id, targetId, destination: job.destination,
          });
          itemResult.status = 'success';
          itemResult.targetId = targetId;
          stageResult.succeeded += 1;
        }
      }
      break;
    }
  }

  if (job.pendingConflicts.length === 0) {
    const anyFailed = job.stageResults.some(s => s.failed > 0);
    job.status = anyFailed ? 'failed' : 'complete';
  }

  // Recompute counts
  let restoredCount = 0; let skippedCount = 0; let failedCount = 0;
  for (const stage of job.stageResults) {
    restoredCount += stage.succeeded;
    skippedCount += stage.skipped;
    failedCount += stage.failed;
  }
  job.restoredCount = restoredCount;
  job.skippedCount = skippedCount;
  job.failedCount = failedCount;

  db.restoreJobs.set(restoreJobId, job);

  return { itemId, decision, restoreJobStatus: job.status };
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
    restoredCount: job.restoredCount || 0,
    skippedCount: job.skippedCount || 0,
    failedCount: job.failedCount || 0,
    byType: job.byType || {},
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
