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

// ── Custom field sanitization ─────────────────────────────────────────────────
// Fields that are NEVER writable via POST /rest/api/3/issue regardless of context.
// Sending these causes a 400 from Jira because they are system-managed, read-only,
// or must be set via a separate API call after issue creation.
const EXCLUDED_CUSTOM_FIELDS = new Set([
  'customfield_10019', // Rank / Global Rank — system-calculated, not settable
  'customfield_10020', // Sprint — must be set via POST /rest/agile/1.0/sprint/{id}/issue after create
  'customfield_10014', // Epic Link — deprecated; use 'parent' field or Epic type instead
  'customfield_10000', // Development field — read-only, managed by Jira dev integrations
  'customfield_10001', // Team — managed by Advanced Roadmaps, not directly settable
  'customfield_10018', // Story Point Estimate (legacy alias) — read-only alias for story points
]);

// ── Error codes that indicate a "skip" rather than a hard failure ─────────────
// These errors mean the item cannot be restored for a structural reason (e.g.
// system fields cannot be created via the Jira API) but should not count toward
// failedCount or block subsequent pipeline stages.
const SKIP_ONLY_CODES = new Set([
  'SYSTEM_FIELD_SKIP',             // System fields (status, summary, etc.) cannot be created
  'UNSUPPORTED_TYPE',              // Object type has no write path in this pipeline version
  'WORKFLOW_DEFINITION_MISSING',   // Backup only has summary; full statuses/transitions unavailable
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

    const computedIssueKey = issueKey || (fields && fields.key) || String(id);
    // Derive projectKey from multiple sources for resilience against old snapshots that lack
    // an explicit projectKey field: prefer stored snapshot.projectKey, then fields.project.key
    // from the Jira API response, then the project-key prefix of the Jira issue key (e.g. "KS"
    // from "KS-5"). This ensures issues in old backups can always resolve their project.
    const issueKeyPrefix = (objectType === 'issue' && typeof computedIssueKey === 'string' && computedIssueKey.includes('-'))
      ? computedIssueKey.split('-').slice(0, -1).join('-')
      : null;
    const resolvedProjectKey = snapshot.projectKey
      || (objectType === 'issue' && fields && fields.project && fields.project.key)
      || issueKeyPrefix
      || null;
    items.push({ id, objectType, fields: fields || {}, issueKey: computedIssueKey, projectKey: resolvedProjectKey, snapshotKey: key });
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
    const fieldId = fields.id || '';
    for (const [key, cf] of db.customFieldDefinitions.entries()) {
      const siteMatch = !destination.targetSiteId || key.startsWith(`${destination.targetSiteId}:`);
      if (siteMatch && (cf.name === name || (fieldId && (cf.fieldId === fieldId || key.endsWith(`:${fieldId}`))))) {
        return true;
      }
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
      // Determine target project key — fallback to issueKey prefix as last resort (e.g. "TS-2" → "TS")
      const issueKeyStr = item.issueKey || item.id;
      const projectKeyFromIssueKey = (typeof issueKeyStr === 'string' && issueKeyStr.includes('-'))
        ? issueKeyStr.split('-').slice(0, -1).join('-')
        : null;
      // Look up the resolved project key from the sourceToTargetIssueKey map (populated when
      // project items are written or skipped earlier in the pipeline). Try all known references.
      const fieldProjectKey = fields.project && fields.project.key;
      const resolvedFromMap = (fieldProjectKey && sourceToTargetIssueKey[`project:${fieldProjectKey}`])
        || (projectKeyFromIssueKey && sourceToTargetIssueKey[`project:${projectKeyFromIssueKey}`]);
      const projKey = targetProjectKey
        || resolvedFromMap
        || fieldProjectKey
        || item.projectKey
        || (fields.project && fields.project.id)
        || projectKeyFromIssueKey;

      if (!projKey) {
        throw Object.assign(new Error('Cannot restore issue: no target project key available'), { code: 'MISSING_PROJECT_KEY' });
      }

      // Include custom fields from the backup, applying sanitization rules:
      // 1. Skip permanently-excluded system/read-only fields (EXCLUDED_CUSTOM_FIELDS).
      // 2. Skip option-typed fields (value is an object with an 'id' property) — option IDs are
      //    context-scoped and won't match target project's field context; safe writable numeric
      //    or text custom fields (string/number values) are kept.
      // For cross-site, apply the field ID mapping (fieldMap); for same-site, use the original key.
      const strippedSanitizedFields = [];
      let customFields = {};
      for (const [k, v] of Object.entries(fields)) {
        if (!k.startsWith('customfield_') || v === null || v === undefined) continue;
        // Rule 1: skip permanently excluded system fields
        if (EXCLUDED_CUSTOM_FIELDS.has(k)) {
          strippedSanitizedFields.push(`${k}(system-excluded)`);
          continue;
        }
        // Rule 2: skip option-typed fields (single-select, multi-select, cascading select)
        // where the backed-up value is an object with an 'id' key — option IDs are context-scoped
        // and will cause 400 on the target unless a field-mapping step has confirmed equivalence.
        if (typeof v === 'object' && !Array.isArray(v) && v !== null && 'id' in v) {
          strippedSanitizedFields.push(`${k}(option-typed)`);
          continue;
        }
        // Rule 2b: array of option objects (multi-select)
        if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null && 'id' in v[0]) {
          strippedSanitizedFields.push(`${k}(option-array)`);
          continue;
        }
        const mappedKey = (destination.isCrossSite && fieldMap && fieldMap[k]) ? fieldMap[k] : k;
        customFields[mappedKey] = v;
      }
      if (strippedSanitizedFields.length > 0) {
        console.info(`[restore] Issue ${issueKeyStr}: sanitized ${strippedSanitizedFields.length} custom fields before create: ${strippedSanitizedFields.join(', ')}`);
      }

      // Build prefixed summary: "[Restored from ORIG-KEY] original summary" (ADR-S22-004)
      // Strip any existing prefix before prepending (idempotent on re-restore).
      const originalKey = item.issueKey || item.id;
      const rawSummary = fields.summary || 'Restored issue';
      const strippedSummary = rawSummary.replace(/^\[Restored from [A-Z][A-Z0-9_]*-\d+\]\s*/, '');
      const prefixedSummary = `[Restored from ${originalKey}] ${strippedSummary}`;

      const issuePayload = {
        fields: {
          project: { key: projKey },
          summary: prefixedSummary,
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

      // Backed-up comments embedded in the issue snapshot (fields.comment.comments[])
      const backedUpComments = (fields.comment && Array.isArray(fields.comment.comments))
        ? fields.comment.comments
        : [];

      if (!jiraAxios) return { targetId: uuidv4(), targetKey: null, payload: issuePayload };

      // Check if the issue already exists at the target by its original key — if so, revert it
      // rather than creating a duplicate. This handles the "restore to original location" case
      // where the user expects the existing issue to be reverted to the backup state.
      const lookupKey = (typeof issueKeyStr === 'string' && issueKeyStr.includes('-')) ? issueKeyStr : null;
      let existingIssueKey = null;
      if (lookupKey) {
        try {
          const existingResp = await jiraAxios.get(`${base}/rest/api/3/issue/${lookupKey}`);
          if (existingResp.data && existingResp.data.key) {
            existingIssueKey = existingResp.data.key;
          }
        } catch (_) { /* issue does not exist yet — will create new */ }
      }

      if (existingIssueKey) {
        // UPDATE the existing issue to match the backup state (revert in place)
        const updateFields = { summary: issuePayload.fields.summary };
        if (issuePayload.fields.description) updateFields.description = issuePayload.fields.description;
        if (issuePayload.fields.priority) updateFields.priority = issuePayload.fields.priority;
        if (issuePayload.fields.labels) updateFields.labels = issuePayload.fields.labels;
        try {
          await jiraAxios.put(`${base}/rest/api/3/issue/${existingIssueKey}`, { fields: updateFields });
        } catch (updateErr) {
          console.warn(`[restore] Could not update existing issue ${existingIssueKey}: ${updateErr.message}`);
        }

        // Revert comments: delete comments not present in the backup, add backed-up ones
        try {
          const commentsResp = await jiraAxios.get(`${base}/rest/api/3/issue/${existingIssueKey}/comment`);
          const currentComments = (commentsResp.data && commentsResp.data.comments) || [];
          const backedUpIds = new Set(backedUpComments.map(c => c.id).filter(Boolean));

          for (const c of currentComments) {
            if (!backedUpIds.has(c.id)) {
              try {
                await jiraAxios.delete(`${base}/rest/api/3/issue/${existingIssueKey}/comment/${c.id}`);
              } catch (_) { /* skip if deletion not permitted (e.g. comment by another user) */ }
            }
          }

          // Add backed-up comments that are not already present, with author attribution header
          const currentIds = new Set(currentComments.map(c => c.id).filter(Boolean));
          for (const comment of backedUpComments) {
            if (comment.id && currentIds.has(comment.id)) continue;
            if (comment.body) {
              try {
                let commentBody = comment.body;
                if (typeof commentBody === 'string') {
                  commentBody = { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: commentBody }] }] };
                }
                // Prepend author attribution ADF header per PRD Constraint 8
                if (comment.author) {
                  commentBody = prependCommentAuthorAdfHeader(
                    commentBody,
                    { displayName: comment.author.displayName || String(comment.author), accountId: comment.author.accountId || '' },
                    comment.created || new Date().toISOString(),
                  );
                }
                await jiraAxios.post(`${base}/rest/api/3/issue/${existingIssueKey}/comment`, { body: commentBody });
              } catch (_) { /* non-fatal */ }
            }
          }
        } catch (commentErr) {
          console.warn(`[restore] Could not revert comments on ${existingIssueKey}: ${commentErr.message}`);
        }

        return { targetId: existingIssueKey, targetKey: existingIssueKey, payload: issuePayload };
      }

      // Issue does not exist — create it (retry without custom fields if 400 from field validation)
      let resp;
      let customFieldsAppliedOnCreate = true;
      try {
        resp = await jiraAxios.post(`${base}/rest/api/3/issue`, issuePayload);
      } catch (createErr) {
        if (createErr.isAxiosError && createErr.response && createErr.response.status === 400) {
          // Log the full 400 error body from Jira to identify the exact field causing rejection
          const errDetail = createErr.response.data;
          console.warn(`[restore] Issue create 400 detail for ${issueKeyStr}: ${JSON.stringify(errDetail)}`);
          if (Object.keys(customFields).length > 0) {
            const removedFields = Object.keys(customFields);
            console.warn(`[restore] Issue create with custom fields failed (400), retrying without custom fields for ${issueKeyStr}. Removed fields: ${removedFields.join(', ')}`);
            const fallbackPayload = { fields: { ...issuePayload.fields } };
            // Preserve Epic Name (customfield_10011) for Epic issue type — Jira requires it on create
            const isEpic = fields.issuetype && (fields.issuetype.name === 'Epic' || fields.issuetype.subtask === false);
            for (const k of Object.keys(customFields)) {
              if (isEpic && k === 'customfield_10011') continue; // preserve Epic Name required for Epic type
              delete fallbackPayload.fields[k];
            }
            resp = await jiraAxios.post(`${base}/rest/api/3/issue`, fallbackPayload);
            customFieldsAppliedOnCreate = false;
          } else {
            throw createErr;
          }
        } else {
          throw createErr;
        }
      }
      const newKey = resp.data.key;

      // Per-field PUT fallback: if custom fields were stripped on retry, attempt to add each
      // custom field one-by-one via PUT to identify which specific field causes failure.
      // Fields that succeed are applied; the exact failing field is logged.
      if (!customFieldsAppliedOnCreate && Object.keys(customFields).length > 0 && newKey) {
        console.info(`[restore] Issue ${newKey} created without custom fields — attempting per-field PUT fallback for ${Object.keys(customFields).length} fields`);
        for (const [cfKey, cfValue] of Object.entries(customFields)) {
          // Skip Epic Name if already included on create (preserved for Epics)
          if (cfKey === 'customfield_10011') continue;
          try {
            await jiraAxios.put(`${base}/rest/api/3/issue/${newKey}`, { fields: { [cfKey]: cfValue } });
            console.info(`[restore] Issue ${newKey}: per-field PUT succeeded for ${cfKey}`);
          } catch (putErr) {
            const putDetail = putErr.response && putErr.response.data ? JSON.stringify(putErr.response.data) : putErr.message;
            console.warn(`[restore] Issue ${newKey}: per-field PUT FAILED for ${cfKey}: ${putDetail}`);
          }
        }
      }

      // Post backed-up comments to the newly created issue
      if (backedUpComments.length > 0 && newKey) {
        for (const comment of backedUpComments) {
          if (comment.body) {
            try {
              await jiraAxios.post(`${base}/rest/api/3/issue/${newKey}/comment`, { body: comment.body });
            } catch (_) { /* non-fatal */ }
          }
        }
      }

      return { targetId: resp.data.id, targetKey: newKey, payload: issuePayload };
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

      if (!jiraAxios) return { targetId: uuidv4(), payload: { fields: { body: adfBody } } };
      const resp = await jiraAxios.post(`${base}/rest/api/3/issue/${targetIssueKey}/comment`, { body: adfBody });
      return { targetId: resp.data.id, payload: { fields: { body: adfBody } } };
    }

    case 'workflow': {
      let payload;
      try {
        payload = buildWorkflowRestorePayload(fields);
      } catch (err) {
        throw Object.assign(new Error(`Cannot restore workflow: ${err.message}`), { code: err.code || 'WORKFLOW_DEFINITION_MISSING' });
      }
      if (!jiraAxios) return { targetId: uuidv4(), payload };
      const resp = await jiraAxios.post(`${base}/rest/api/3/workflow/create`, payload);
      const entityId = (resp.data.id && typeof resp.data.id === 'object')
        ? (resp.data.id.entityId || resp.data.id.name)
        : (resp.data.id || resp.data.entityId);
      return { targetId: entityId || uuidv4() };
    }

    case 'customFieldDefinition': {
      // Only custom fields (not system fields) can be created via the API
      if (!(fields.id && fields.id.startsWith('customfield_'))) {
        throw Object.assign(new Error('Skipping system field restore'), { code: 'SYSTEM_FIELD_SKIP' });
      }
      // Do not include `type` on existing fields — it is immutable after creation.
      // The POST body is only used for net-new fields; existing ones return 400.
      const fieldPayload = {
        name: fields.name || 'Restored Field',
        type: (fields.schema && fields.schema.custom) || 'com.atlassian.jira.plugin.system.customfieldtypes:textfield',
      };
      if (!jiraAxios) return { targetId: fields.id || uuidv4(), payload: fieldPayload };
      try {
        const resp = await jiraAxios.post(`${base}/rest/api/3/field`, fieldPayload);
        return { targetId: resp.data.id };
      } catch (err) {
        if (err.isAxiosError && err.response && err.response.status === 400) {
          // Field already exists on target site — reuse the source field ID
          return { targetId: fields.id, alreadyExists: true };
        }
        throw err;
      }
    }

    case 'project': {
      const projKey = (fields.key || 'REST').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'REST';
      const projPayload = {
        key: projKey,
        name: fields.name || 'Restored Project',
        projectTypeKey: fields.projectTypeKey || 'software',
        projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-scrum-template',
        description: fields.description || 'Restored from backup',
      };
      if (fields.lead && fields.lead.accountId) {
        projPayload.leadAccountId = fields.lead.accountId;
      }
      if (!jiraAxios) return { targetId: uuidv4(), targetKey: projKey, payload: projPayload };
      try {
        const resp = await jiraAxios.post(`${base}/rest/api/3/project`, projPayload);
        return { targetId: String(resp.data.id), targetKey: resp.data.key || projKey };
      } catch (err) {
        if (err.isAxiosError && err.response && err.response.status === 400) {
          // Project already exists on target site — return its key so issues can still be restored
          return { targetId: `existing:${projKey}`, targetKey: projKey, alreadyExists: true };
        }
        throw err;
      }
    }

    case 'board': {
      // ADR-S22-003: use location.projectKey, not filterId (source-site artifact)
      const boardProjectKey = (fields.location && fields.location.projectKey)
        || targetProjectKey
        || null;
      const boardPayload = {
        name: fields.name || 'Restored Board',
        type: fields.type || 'scrum',
        location: boardProjectKey
          ? { type: 'project', projectKeyOrId: boardProjectKey }
          : undefined,
      };
      if (!boardPayload.location) delete boardPayload.location;
      if (!jiraAxios) return { targetId: uuidv4(), payload: boardPayload };
      try {
        const resp = await jiraAxios.post(`${base}/rest/agile/1.0/board`, boardPayload);
        return { targetId: String(resp.data.id) };
      } catch (err) {
        // 400: bad request, 401: missing write:board-scope:jira-software OAuth scope,
        // 403: forbidden — all are skipped gracefully; boards are optional restore artifacts.
        if (err.isAxiosError && err.response && [400, 401, 403].includes(err.response.status)) {
          const scopeHint = err.response.status === 401
            ? ' (missing write:board-scope:jira-software OAuth scope — re-authorise to enable board restore)'
            : '';
          console.warn(`[restore] Board create failed (${err.response.status}), skipping${scopeHint}: ${err.message}`);
          return { targetId: uuidv4(), skipped: true };
        }
        throw err;
      }
    }

    case 'attachment': {
      // Re-upload an attachment to the target issue
      const sourceIssueId = fields.issueId || fields.issueKey || item.issueKey;
      const targetIssueKey = (sourceIssueId && sourceToTargetIssueKey[sourceIssueId])
        || (sourceIssueId && sourceToTargetIssueKey[String(sourceIssueId)])
        || sourceIssueId;

      if (!targetIssueKey) {
        throw Object.assign(new Error('Cannot restore attachment: target issue key unknown'), { code: 'MISSING_ISSUE_KEY' });
      }

      const storageRef = fields.binaryStorageRef || item.binaryStorageRef;
      if (!storageRef) {
        // Sidecar-only attachment — no binary was downloaded during backup; skip gracefully
        return { targetId: uuidv4(), skipped: true };
      }

      const { downloadBinaryFromStorage } = require('./attachmentMaterialisation');
      const binary = downloadBinaryFromStorage(storageRef);
      if (!binary) {
        // Binary missing from disk (e.g. orphaned sidecar ref) — skip gracefully
        return { targetId: uuidv4(), skipped: true };
      }

      if (!jiraAxios) return { targetId: uuidv4(), skipped: true };

      // Multipart upload — requires X-Atlassian-Token: no-check
      const FormData = require('form-data');
      const form = new FormData();
      form.append('file', binary, { filename: fields.filename || 'attachment', contentType: fields.mimeType || 'application/octet-stream' });
      const resp = await jiraAxios.post(
        `${base}/rest/api/3/issue/${targetIssueKey}/attachments`,
        form,
        { headers: { ...form.getHeaders(), 'X-Atlassian-Token': 'no-check' } },
      );
      const attachmentId = resp.data && Array.isArray(resp.data) && resp.data[0] ? resp.data[0].id : uuidv4();
      return { targetId: String(attachmentId) };
    }

    case 'sprint': {
      const sourceBoardId = fields.boardId || fields.originBoardId;
      const targetBoardId = sourceBoardId && sourceToTargetIssueKey[`board:${String(sourceBoardId)}`];
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
      if (!jiraAxios) return { targetId: uuidv4(), payload: sprintPayload };
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
      try { payload = buildWorkflowRestorePayload(item.fields); }
      catch (err) {
        const errorCode = err.code || 'WORKFLOW_DEFINITION_MISSING';
        return { error: errorCode, skip: SKIP_ONLY_CODES.has(errorCode), targetId: null };
      }
    }
    if (item.objectType === 'customFieldDefinition') {
      const fields = item.fields || {};
      if (!(fields.id && fields.id.startsWith('customfield_'))) {
        return { error: 'SYSTEM_FIELD_SKIP', skip: true, targetId: null };
      }
    }

    const storeKey = `${restoreJobId}:${item.objectType}:${item.id}`;
    db.restoredObjects.set(storeKey, { restoreJobId, objectType: item.objectType, id: item.id, targetId, payload, destination });
    return { targetId, exportEntry: { id: item.id, objectType: item.objectType, targetId, payload } };
  }

  // Original or alternate destination: write to Jira API
  try {
    const { targetId, targetKey, payload } = await writeObjectToJira(
      jiraAxios, cloudId, item, destination, targetProjectKey, fieldMap, sourceToTargetIssueKey,
    );

    const storeKey = `${restoreJobId}:${item.objectType}:${item.id}`;
    db.restoredObjects.set(storeKey, {
      restoreJobId,
      objectType: item.objectType,
      id: item.id,
      targetId,
      targetKey: targetKey || null,
      payload: payload || null,
      destination,
    });

    return { targetId, targetKey };
  } catch (err) {
    const errorCode = err.code
      || (err.isAxiosError && err.response ? `JIRA_API_${err.response.status}` : 'JIRA_API_ERROR');
    const isSkip = SKIP_ONLY_CODES.has(errorCode);
    if (!isSkip) {
      const itemIdStr = (item.id && typeof item.id === 'object')
        ? (item.id.entityId || item.id.name || JSON.stringify(item.id))
        : String(item.id);
      console.warn(`[restore] Failed to write ${item.objectType} id=${itemIdStr}: ${errorCode} — ${err.message}`);
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
        // For projects: register the existing key so dependent issues can still resolve their project
        if (item.objectType === 'project') {
          const projKey = (item.fields && item.fields.key) || (typeof item.id === 'string' ? item.id : null);
          if (projKey) sourceToTargetIssueKey[`project:${projKey}`] = projKey;
        }
        itemResults.push({
          id: item.id,
          objectType: item.objectType,
          status: 'skipped',
          skipReason: 'CONFLICT_SKIPPED',
          originalKey: item.issueKey || undefined,
        });
        continue;
      }

      if (conflictModeEffective === 'override') {
        const { targetId, targetKey, error, skip } = await applyObjectToDestination(
          restoreJobId, item, destination, fieldMap, newBoardIdMap, jiraAxios, cloudId, sourceToTargetIssueKey, targetProjectKey,
        );
        if (error) {
          // For projects: register the source key in the map even on failure so that dependent
          // issues can still resolve their project key via the item.projectKey fallback.
          if (item.objectType === 'project' && !skip) {
            const projKey = (item.fields && item.fields.key) || (typeof item.id === 'string' ? item.id : null);
            if (projKey) sourceToTargetIssueKey[`project:${projKey}`] = projKey;
          }
          itemResults.push({ id: item.id, objectType: item.objectType, status: skip ? 'skipped' : 'failed', errorCode: error, originalKey: item.issueKey || undefined });
        } else {
          if (item.objectType === 'board') { newBoardIdMap[item.id] = targetId; sourceToTargetIssueKey[`board:${item.id}`] = targetId; }
          if (item.objectType === 'sprint') { sourceToTargetIssueKey[`sprint:${item.id}`] = targetId; }
          if (item.objectType === 'issue' && targetKey) sourceToTargetIssueKey[item.id] = targetKey;
          if (item.objectType === 'project' && targetKey) sourceToTargetIssueKey[`project:${targetKey}`] = targetKey;
          itemResults.push({ id: item.id, objectType: item.objectType, status: 'success', targetId, targetKey, originalKey: item.issueKey || undefined });
          if (destination.type === 'export' && exportEntries) exportEntries.push({ id: item.id, objectType: item.objectType, targetId });
        }
        continue;
      }

      if (conflictModeEffective === 'ask') {
        pendingConflicts.push({ itemId: item.id, objectType: item.objectType });
        itemResults.push({ id: item.id, objectType: item.objectType, status: 'pending', skipReason: 'AWAITING_CONFLICT_DECISION', originalKey: item.issueKey || undefined });
        continue;
      }
    }

    // No conflict (or resolved): restore the object
    const { targetId, targetKey, error, exportEntry, skip } = await applyObjectToDestination(
      restoreJobId, item, destination, fieldMap, newBoardIdMap, jiraAxios, cloudId, sourceToTargetIssueKey, targetProjectKey,
    );

    if (error) {
      // For projects: register the source key in the map even on failure so that dependent
      // issues can still resolve their project key via the item.projectKey fallback.
      if (item.objectType === 'project' && !skip) {
        const projKey = (item.fields && item.fields.key) || (typeof item.id === 'string' ? item.id : null);
        if (projKey) sourceToTargetIssueKey[`project:${projKey}`] = projKey;
      }
      itemResults.push({ id: item.id, objectType: item.objectType, status: skip ? 'skipped' : 'failed', errorCode: error, originalKey: item.issueKey || undefined });
    } else {
      if (item.objectType === 'board') { newBoardIdMap[item.id] = targetId; sourceToTargetIssueKey[`board:${item.id}`] = targetId; }
      if (item.objectType === 'sprint') { sourceToTargetIssueKey[`sprint:${item.id}`] = targetId; }
      if (item.objectType === 'issue' && targetKey) sourceToTargetIssueKey[item.id] = targetKey;
      if (item.objectType === 'project' && targetKey) sourceToTargetIssueKey[`project:${targetKey}`] = targetKey;
      itemResults.push({ id: item.id, objectType: item.objectType, status: 'success', targetId, targetKey, originalKey: item.issueKey || undefined });
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

// ── Stage 3b: Issue Link restore ─────────────────────────────────────────────

/**
 * After all issues are restored, create issue links using the source→target key map.
 * Links reference original Jira issue keys; we map them to target keys via sourceToTargetIssueKey.
 *
 * @param {object[]} basket
 * @param {object} sourceToTargetIssueKey
 * @param {import('axios').AxiosInstance} jiraAxios
 * @param {string} cloudId
 * @returns {Promise<{succeeded: number, failed: number}>}
 */
async function restoreIssueLinks(basket, sourceToTargetIssueKey, jiraAxios, cloudId) {
  if (!jiraAxios) return { succeeded: 0, failed: 0 };
  const base = `${JIRA_API_BASE}/${cloudId}`;
  let succeeded = 0;
  let failed = 0;

  for (const item of basket) {
    if (item.objectType !== 'issue') continue;
    const links = (item.fields && item.fields.issuelinks) || [];
    for (const link of links) {
      try {
        const linkTypeName = (link.type && link.type.name) || 'Relates';
        let outwardKey = null;
        let inwardKey = null;

        if (link.outwardIssue) {
          const srcKey = link.outwardIssue.key;
          outwardKey = sourceToTargetIssueKey[srcKey] || sourceToTargetIssueKey[link.outwardIssue.id] || srcKey;
        }
        if (link.inwardIssue) {
          const srcKey = link.inwardIssue.key;
          inwardKey = sourceToTargetIssueKey[srcKey] || sourceToTargetIssueKey[link.inwardIssue.id] || srcKey;
        }

        const thisIssueTargetKey = sourceToTargetIssueKey[item.id] || sourceToTargetIssueKey[item.issueKey] || item.issueKey;

        // Build link request: one of inward/outward must be the current issue
        const inwardIssueKey = inwardKey || thisIssueTargetKey;
        const outwardIssueKey = outwardKey || thisIssueTargetKey;

        if (!inwardIssueKey || !outwardIssueKey || inwardIssueKey === outwardIssueKey) continue;

        await jiraAxios.post(`${base}/rest/api/3/issueLink`, {
          type: { name: linkTypeName },
          inwardIssue: { key: inwardIssueKey },
          outwardIssue: { key: outwardIssueKey },
        });
        succeeded++;
      } catch (err) {
        failed++;
        console.debug(`[restore] Issue link creation failed: ${err.message}`);
      }
    }
  }

  return { succeeded, failed };
}

// ── Stage 5b: Issue → Sprint association ─────────────────────────────────────

/**
 * After sprints are restored, associate issues with their target sprints.
 * Source sprint ID is read from fields.customfield_10020 (sprint field).
 *
 * @param {object[]} basket
 * @param {object} sourceToTargetIssueKey  Also contains sprint:${sourceSprintId} → targetSprintId
 * @param {import('axios').AxiosInstance} jiraAxios
 * @param {string} cloudId
 * @returns {Promise<{succeeded: number, failed: number}>}
 */
async function associateIssuesToSprints(basket, sourceToTargetIssueKey, jiraAxios, cloudId) {
  if (!jiraAxios) return { succeeded: 0, failed: 0 };
  const base = `${JIRA_API_BASE}/${cloudId}`;
  let succeeded = 0;
  let failed = 0;

  // Group issues by their target sprint
  const sprintToIssues = {};
  for (const item of basket) {
    if (item.objectType !== 'issue') continue;
    const targetKey = sourceToTargetIssueKey[item.id] || sourceToTargetIssueKey[item.issueKey];
    if (!targetKey) continue;

    // customfield_10020 is the Sprint field — it's an array of sprint objects or IDs
    const sprintField = item.fields && item.fields.customfield_10020;
    const sprintValues = Array.isArray(sprintField) ? sprintField : (sprintField ? [sprintField] : []);

    for (const sprintVal of sprintValues) {
      const srcSprintId = String(typeof sprintVal === 'object' ? (sprintVal.id || sprintVal) : sprintVal);
      const targetSprintId = sourceToTargetIssueKey[`sprint:${srcSprintId}`];
      if (!targetSprintId) continue;
      if (!sprintToIssues[targetSprintId]) sprintToIssues[targetSprintId] = [];
      sprintToIssues[targetSprintId].push(targetKey);
    }
  }

  for (const [targetSprintId, issueKeys] of Object.entries(sprintToIssues)) {
    // POST /rest/agile/1.0/sprint/{id}/issue in batches of 50
    for (let i = 0; i < issueKeys.length; i += 50) {
      const batch = issueKeys.slice(i, i + 50);
      try {
        await jiraAxios.post(`${base}/rest/agile/1.0/sprint/${targetSprintId}/issue`, { issues: batch });
        succeeded += batch.length;
      } catch (err) {
        failed += batch.length;
        console.debug(`[restore] Sprint issue association failed for sprintId=${targetSprintId}: ${err.message}`);
      }
    }
  }

  return { succeeded, failed };
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
  console.info(`[restore] pre-validation: backupPointId=${backupPointId} targetSiteId=${targetSiteId} effectiveCloudId=${effectiveCloudId} targetProjectKey=${targetProjectKey || '(none)'} basketSize=${basketItems.length}`);
  const validationResult = runValidationPipeline({
    restoreRequest,
    targetSiteId,
    targetProjectKey,
    basketItems,
    includeBoardSprintRestore,
  });
  console.info(`[restore] post-validation: passed=${validationResult.passed} warnings=${validationResult.warnings ? validationResult.warnings.length : 0}${!validationResult.passed ? ' blockingErrorCode=' + (validationResult.blockingError && validationResult.blockingError.errorCode) : ''}`);

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

    // Stage 3b: restore issue links after all issues have been created (stage 3)
    if (stageNum === 3 && jiraAxios && destination.type !== 'export') {
      try {
        const linkResult = await restoreIssueLinks(basketItems, sourceToTargetIssueKey, jiraAxios, effectiveCloudId);
        console.info(`[restore] Stage 3b (issue links): succeeded=${linkResult.succeeded} failed=${linkResult.failed}`);
      } catch (err) {
        console.warn(`[restore] Stage 3b (issue links) failed non-fatally: ${err.message}`);
      }
    }

    // Stage 5b: associate issues to restored sprints after sprints are created (stage 5)
    if (stageNum === 5 && jiraAxios && destination.type !== 'export') {
      try {
        const sprintAssocResult = await associateIssuesToSprints(basketItems, sourceToTargetIssueKey, jiraAxios, effectiveCloudId);
        console.info(`[restore] Stage 5b (sprint→issue): succeeded=${sprintAssocResult.succeeded} failed=${sprintAssocResult.failed}`);
      } catch (err) {
        console.warn(`[restore] Stage 5b (sprint→issue) failed non-fatally: ${err.message}`);
      }
    }
  }

  // Compute aggregate counts
  let restoredCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const byType = {};
  const failureMessages = [];

  for (const stage of job.stageResults) {
    restoredCount += stage.succeeded;
    skippedCount += stage.skipped;
    failedCount += stage.failed;
    for (const item of stage.items || []) {
      if (!byType[item.objectType]) byType[item.objectType] = { restored: 0, skipped: 0, failed: 0 };
      if (item.status === 'success') byType[item.objectType].restored += 1;
      else if (item.status === 'skipped') byType[item.objectType].skipped += 1;
      else if (item.status === 'failed') {
        byType[item.objectType].failed += 1;
        if (failureMessages.length < 5 && item.errorCode) {
          const itemId = (item.id && typeof item.id === 'object')
            ? (item.id.entityId || item.id.name || String(item.id))
            : String(item.id);
          failureMessages.push({ objectType: item.objectType, id: itemId, errorCode: item.errorCode });
        }
      }
    }
  }

  // Detect AUTH_ERROR in board/sprint stages and surface a structured RECONNECT_REQUIRED error.
  // Board/sprint items are in stages 4 and 5 (COMMENTS_ATTACHMENTS_BOARDS and SPRINTS).
  const BOARD_SPRINT_STAGES = new Set([
    RESTORE_STAGE_ORDER.COMMENTS_ATTACHMENTS_BOARDS,
    RESTORE_STAGE_ORDER.SPRINTS,
  ]);
  const authErrorItems = [];
  for (const stage of job.stageResults) {
    if (!BOARD_SPRINT_STAGES.has(stage.stageNumber)) continue;
    for (const item of stage.items || []) {
      if (item.errorCode === 'AUTH_ERROR' && (item.objectType === 'board' || item.objectType === 'sprint')) {
        authErrorItems.push({ objectType: item.objectType, id: item.id });
      }
    }
  }
  if (authErrorItems.length > 0) {
    job.authError = {
      code: 'RECONNECT_REQUIRED',
      connectionId,
      detail: 'Atlassian rejected the access token for board/sprint writes. The integration may be missing write:board-scope:jira-software or the token has been permanently revoked. Please reconnect the integration.',
      affectedItems: authErrorItems,
    };
  }

  // Finalize job status based on counts
  if (job.pendingConflicts.length > 0) {
    job.status = 'running';
  } else if (failedCount > 0) {
    job.status = 'complete_with_errors';
  } else {
    job.status = 'complete';
  }

  job.restoredCount = restoredCount;
  job.skippedCount = skippedCount;
  job.failedCount = failedCount;
  job.byType = byType;
  job.failureMessages = failureMessages;

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
    job.status = anyFailed ? 'complete_with_errors' : 'complete';
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
  if (job.failedCount > 0 && job.failureMessages && job.failureMessages.length > 0) {
    response.errors = job.failureMessages;
  }
  if (job.authError) {
    response.authError = job.authError;
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
