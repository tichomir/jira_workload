'use strict';

/**
 * Sprint 3 — Backup Point Routes
 *
 * Endpoints:
 *   GET /api/v1/backup-points/:backupPointId/issues   — Issue search within a backup point
 *   GET /api/v1/backup-points/:backupPointId/objects  — Object Explorer diff results
 */

const express = require('express');
const db = require('../db');
const {
  fulltextMatch,
  keywordExactMatch,
  parseRange,
  matchesRange,
  paginateResults,
  parseLimit,
} = require('../services/searchService');
const {
  VALID_NODE_TYPES,
  VALID_CHANGE_INDICATORS,
  runObjectExplorerDiff,
} = require('../services/objectExplorerService');

const router = express.Router({ mergeParams: true });

function errorResponse(res, status, code, message, fields) {
  return res.status(status).json({ error: code, message, ...(fields ? { fields } : {}) });
}

const VALID_STATUS_CATEGORIES = new Set(['To Do', 'In Progress', 'Done']);

// ---------------------------------------------------------------------------
// GET /api/v1/backup-points/:backupPointId/issues
// ---------------------------------------------------------------------------
router.get('/:backupPointId/issues', (req, res) => {
  const { backupPointId } = req.params;
  const { q, issuetype, status, statusCategory, priority, assignee, reporter, labels,
          created, updated, resolved, projectKey, cursor } = req.query;
  const limit = parseLimit(req.query.limit);

  // Validate backupPointId
  if (!db.backupPoints.has(backupPointId)) {
    return errorResponse(res, 404, 'BACKUP_POINT_NOT_FOUND',
      `Backup point ${backupPointId} not found`);
  }

  // Validate statusCategory values
  if (statusCategory) {
    const scValues = statusCategory.split(',').map(s => s.trim());
    for (const sc of scValues) {
      if (!VALID_STATUS_CATEGORIES.has(sc)) {
        return errorResponse(res, 400, 'INVALID_STATUS_CATEGORY',
          `statusCategory must be one of: ${[...VALID_STATUS_CATEGORIES].join(', ')}`);
      }
    }
  }

  // Parse range filters
  let createdRange, updatedRange, resolvedRange;
  try {
    createdRange = parseRange(created);
    updatedRange = parseRange(updated);
    resolvedRange = parseRange(resolved);
  } catch {
    return errorResponse(res, 400, 'INVALID_RANGE_FORMAT',
      'Range parameter does not match expected format (e.g. gte:2026-01-01,lte:2026-04-30)');
  }

  // Parse multi-value filter lists
  const issuetypeList  = issuetype     ? issuetype.split(',').map(s => s.trim())  : null;
  const statusList     = status        ? status.split(',').map(s => s.trim())      : null;
  const scList         = statusCategory? statusCategory.split(',').map(s => s.trim()): null;
  const priorityList   = priority      ? priority.split(',').map(s => s.trim())   : null;
  const assigneeList   = assignee      ? assignee.split(',').map(s => s.trim())   : null;
  const reporterList   = reporter      ? reporter.split(',').map(s => s.trim())   : null;
  const labelsList     = labels        ? labels.split(',').map(s => s.trim())     : null;
  const projectKeyList = projectKey    ? projectKey.split(',').map(s => s.trim()) : null;

  const results = [];

  for (const issue of db.searchIssues.values()) {
    if (issue.backupPointId !== backupPointId) continue;

    // Fulltext on summary and key
    if (q) {
      const summaryMatch = fulltextMatch(issue.summary, q);
      const keyMatch = fulltextMatch(issue.key, q);
      if (!summaryMatch && !keyMatch) continue;
    }

    // issuetype — OR semantics
    if (issuetypeList && !issuetypeList.some(v => keywordExactMatch(issue.issuetype, v))) continue;

    // status — OR semantics
    if (statusList && !statusList.some(v => keywordExactMatch(issue.status, v))) continue;

    // statusCategory — OR semantics
    if (scList && !scList.some(v => keywordExactMatch(issue.statusCategory, v))) continue;

    // priority — OR semantics
    if (priorityList && !priorityList.some(v => keywordExactMatch(issue.priority, v))) continue;

    // assignee — OR semantics; "unassigned" sentinel matches null/missing assignee
    if (assigneeList) {
      const wantsUnassigned = assigneeList.includes('unassigned');
      const issueAssigneeId = issue.assignee ? issue.assignee.accountId : null;
      if (wantsUnassigned && !issueAssigneeId) {
        // match
      } else if (!assigneeList.some(v => v !== 'unassigned' && keywordExactMatch(issueAssigneeId, v))) {
        continue;
      }
    }

    // reporter — OR semantics
    if (reporterList) {
      const reporterAccountId = issue.reporter ? issue.reporter.accountId : null;
      if (!reporterList.some(v => keywordExactMatch(reporterAccountId, v))) continue;
    }

    // labels — AND semantics (issue must carry ALL specified labels)
    if (labelsList && labelsList.length > 0) {
      if (!issue.labels || issue.labels.length === 0) continue;
      if (!labelsList.every(l => issue.labels.some(il => keywordExactMatch(il, l)))) continue;
    }

    // created range
    if (!matchesRange(issue.created, createdRange)) continue;

    // updated range
    if (!matchesRange(issue.updated, updatedRange)) continue;

    // resolved range — null resolved excluded when filter present
    if (resolvedRange && !matchesRange(issue.resolved, resolvedRange)) continue;

    // projectKey — OR semantics
    if (projectKeyList && !projectKeyList.some(v => keywordExactMatch(issue.projectKey, v))) continue;

    results.push({
      id: issue.id,
      key: issue.key,
      summary: issue.summary,
      issuetype: issue.issuetype,
      status: issue.status,
      statusCategory: issue.statusCategory,
      priority: issue.priority || null,
      assignee: issue.assignee || null,
      reporter: issue.reporter || null,
      labels: issue.labels || [],
      created: issue.created,
      updated: issue.updated,
      resolved: issue.resolved || null,
      projectKey: issue.projectKey,
    });
  }

  // Sort by updated DESC, then id ASC
  results.sort((a, b) => {
    const dc = new Date(b.updated) - new Date(a.updated);
    return dc !== 0 ? dc : a.id.localeCompare(b.id);
  });

  const { items, nextCursor } = paginateResults(results, limit, cursor, item => item.updated);

  return res.status(200).json({
    results: items,
    total: results.length,
    nextCursor,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/backup-points/:backupPointId/objects
// ---------------------------------------------------------------------------
router.get('/:backupPointId/objects', (req, res) => {
  const { backupPointId } = req.params;
  const { nodeType, parentId, cursor } = req.query;
  const limit = parseLimit(req.query.limit);

  // Validate backupPointId
  if (!db.backupPoints.has(backupPointId)) {
    return errorResponse(res, 404, 'BACKUP_POINT_NOT_FOUND',
      `Backup point ${backupPointId} not found`);
  }

  // Validate nodeType (required)
  if (!nodeType) {
    return errorResponse(res, 400, 'INVALID_NODE_TYPE', 'nodeType is required');
  }
  if (!VALID_NODE_TYPES.has(nodeType)) {
    return errorResponse(res, 400, 'INVALID_NODE_TYPE',
      `nodeType must be one of: ${[...VALID_NODE_TYPES].join(', ')}`);
  }

  // Parse showUnchanged — default false
  let showUnchanged = false;
  if (req.query.showUnchanged !== undefined) {
    const v = String(req.query.showUnchanged).toLowerCase();
    if (v === 'true') showUnchanged = true;
    else if (v === 'false') showUnchanged = false;
  }

  // Parse changeIndicator parameter (overrides showUnchanged if provided)
  let changeIndicatorFilter;
  if (req.query.changeIndicator) {
    const indicators = req.query.changeIndicator.split(',').map(s => s.trim());
    for (const ind of indicators) {
      if (!VALID_CHANGE_INDICATORS.has(ind)) {
        return errorResponse(res, 400, 'INVALID_CHANGE_INDICATOR',
          `changeIndicator must be one of: ${[...VALID_CHANGE_INDICATORS].join(', ')}`);
      }
    }
    changeIndicatorFilter = indicators;
  } else {
    changeIndicatorFilter = showUnchanged
      ? ['Added', 'Modified', 'Deleted', 'Unchanged']
      : ['Added', 'Modified', 'Deleted'];
  }

  try {
    const result = runObjectExplorerDiff(
      backupPointId, nodeType, changeIndicatorFilter, parentId, limit, cursor
    );
    return res.status(200).json(result);
  } catch (err) {
    if (err.code === 'BACKUP_POINT_NOT_FOUND') {
      return errorResponse(res, 404, err.code, err.message);
    }
    throw err;
  }
});

module.exports = router;
