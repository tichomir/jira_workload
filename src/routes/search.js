'use strict';

/**
 * Sprint 3 — Search API Routes
 *
 * Endpoints:
 *   GET /api/v1/search/global           — Global search across all node types and sites
 *   GET /api/v1/search/projects         — Project inventory search
 *   GET /api/v1/search/attachments      — Attachment search
 *   GET /api/v1/search/boards-sprints   — Board and Sprint combined search
 */

const express = require('express');
const db = require('../db');
const {
  fulltextMatch,
  keywordPrefixMatch,
  keywordExactMatch,
  parseRange,
  matchesRange,
  paginateResults,
  parseLimit,
} = require('../services/searchService');

const router = express.Router();

function errorResponse(res, status, code, message, fields) {
  return res.status(status).json({ error: code, message, ...(fields ? { fields } : {}) });
}

// Valid node types for global search
const GLOBAL_NODE_TYPES = new Set(['JiraProjectNode', 'JiraWorkflowNode', 'JiraCustomFieldNode']);

// Valid sprint states
const VALID_SPRINT_STATES = new Set(['active', 'closed', 'future']);

// Valid projectTypeKey values
const VALID_PROJECT_TYPE_KEYS = new Set(['software', 'business', 'service_desk']);

// ---------------------------------------------------------------------------
// GET /api/v1/search/global
// ---------------------------------------------------------------------------
router.get('/global', (req, res) => {
  const { q, siteId, nodeType, cursor } = req.query;
  const limit = parseLimit(req.query.limit);

  // Validate q
  if (!q || q.trim().length === 0) {
    return errorResponse(res, 400, 'MISSING_QUERY', 'q parameter is required and must not be empty');
  }

  // Validate nodeType
  if (nodeType && !GLOBAL_NODE_TYPES.has(nodeType)) {
    return errorResponse(res, 400, 'INVALID_NODE_TYPE',
      `nodeType must be one of: ${[...GLOBAL_NODE_TYPES].join(', ')}`);
  }

  // Validate siteId if provided — check it exists in cloudSites
  if (siteId) {
    const siteExists = [...db.cloudSites.values()].some(s => s.cloudId === siteId || s.id === siteId);
    if (!siteExists) {
      return errorResponse(res, 404, 'SITE_NOT_FOUND', `No connected site found with siteId: ${siteId}`);
    }
  }

  const results = [];

  // Search JiraProjectNode
  if (!nodeType || nodeType === 'JiraProjectNode') {
    for (const proj of db.searchProjects.values()) {
      if (siteId && proj.siteId !== siteId) continue;
      const nameMatch = fulltextMatch(proj.name, q);
      const keyMatch = proj.key && keywordPrefixMatch(proj.key, q);
      if (!nameMatch && !keyMatch) continue;

      const site = siteId
        ? ([...db.cloudSites.values()].find(s => s.cloudId === siteId || s.id === siteId))
        : ([...db.cloudSites.values()].find(s => s.cloudId === proj.siteId || s.id === proj.siteId));

      results.push({
        id: proj.id,
        nodeType: 'JiraProjectNode',
        siteId: proj.siteId,
        siteName: site ? site.name : '',
        key: proj.key || null,
        name: proj.name,
        matchedOn: nameMatch ? 'name' : 'key',
      });
    }
  }

  // Search JiraWorkflowNode
  if (!nodeType || nodeType === 'JiraWorkflowNode') {
    for (const wf of db.workflowNodes.values()) {
      if (siteId && wf.cloudId !== siteId) continue;
      const nameMatch = fulltextMatch(wf.name, q);
      const keyMatch = wf.entityId && keywordPrefixMatch(wf.entityId, q);
      if (!nameMatch && !keyMatch) continue;

      const site = [...db.cloudSites.values()].find(s => s.cloudId === wf.cloudId);
      results.push({
        id: wf.id,
        nodeType: 'JiraWorkflowNode',
        siteId: wf.cloudId,
        siteName: site ? site.name : '',
        key: wf.entityId || null,
        name: wf.name,
        matchedOn: nameMatch ? 'name' : 'key',
      });
    }
  }

  // Search JiraCustomFieldNode (using customFieldDefinitions)
  if (!nodeType || nodeType === 'JiraCustomFieldNode') {
    for (const field of db.customFieldDefinitions.values()) {
      if (siteId && field.cloudId !== siteId) continue;
      const nameMatch = fulltextMatch(field.name, q);
      const keyMatch = field.key && keywordPrefixMatch(field.key, q);
      if (!nameMatch && !keyMatch) continue;

      const site = [...db.cloudSites.values()].find(s => s.cloudId === field.cloudId);
      results.push({
        id: field.id,
        nodeType: 'JiraCustomFieldNode',
        siteId: field.cloudId,
        siteName: site ? site.name : '',
        key: field.key || null,
        name: field.name,
        matchedOn: nameMatch ? 'name' : 'key',
      });
    }
  }

  // Sort by name ASC, then id ASC
  results.sort((a, b) => {
    const nc = a.name.localeCompare(b.name);
    return nc !== 0 ? nc : a.id.localeCompare(b.id);
  });

  const { items, nextCursor } = paginateResults(results, limit, cursor, item => item.name);

  return res.status(200).json({
    results: items,
    total: results.length,
    nextCursor,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/search/projects
// ---------------------------------------------------------------------------
router.get('/projects', (req, res) => {
  const { q, key, projectTypeKey, cursor } = req.query;
  const limit = parseLimit(req.query.limit);

  // Parse archived boolean
  let archived = undefined;
  if (req.query.archived !== undefined && req.query.archived !== '') {
    const archivedStr = String(req.query.archived).toLowerCase();
    if (archivedStr === 'true') archived = true;
    else if (archivedStr === 'false') archived = false;
    else {
      return errorResponse(res, 400, 'INVALID_ARCHIVED_VALUE',
        'archived must be "true" or "false"');
    }
  }

  // Validate projectTypeKey
  if (projectTypeKey && !VALID_PROJECT_TYPE_KEYS.has(projectTypeKey)) {
    return errorResponse(res, 400, 'INVALID_PROJECT_TYPE_KEY',
      `projectTypeKey must be one of: ${[...VALID_PROJECT_TYPE_KEYS].join(', ')}`);
  }

  const results = [];

  for (const proj of db.searchProjects.values()) {
    // Tokenised name match
    if (q && !fulltextMatch(proj.name, q)) continue;

    // Key prefix/exact match
    if (key && !keywordPrefixMatch(proj.key, key) && !keywordExactMatch(proj.key, key)) continue;

    // projectTypeKey exact match
    if (projectTypeKey && !keywordExactMatch(proj.projectTypeKey, projectTypeKey)) continue;

    // archived boolean filter
    if (archived !== undefined && Boolean(proj.archived) !== archived) continue;

    results.push({
      id: proj.id,
      key: proj.key,
      name: proj.name,
      projectTypeKey: proj.projectTypeKey,
      archived: Boolean(proj.archived),
      issueCount: proj.issueCount || 0,
      lastUpdated: proj.lastUpdated || null,
    });
  }

  // Sort by name ASC, then id ASC
  results.sort((a, b) => {
    const nc = a.name.localeCompare(b.name);
    return nc !== 0 ? nc : a.id.localeCompare(b.id);
  });

  const { items, nextCursor } = paginateResults(results, limit, cursor, item => item.name);

  return res.status(200).json({
    results: items,
    total: results.length,
    nextCursor,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/search/attachments
// ---------------------------------------------------------------------------
router.get('/attachments', (req, res) => {
  const { q, mimeType, issueId, cursor } = req.query;
  const limit = parseLimit(req.query.limit);

  // Parse created range
  let createdRange = null;
  const createdParam = req.query.createdFrom || req.query.created;
  if (createdParam) {
    try {
      createdRange = parseRange(createdParam);
    } catch {
      return errorResponse(res, 400, 'INVALID_RANGE_FORMAT',
        'created / createdFrom range parameter is malformed');
    }
  }

  // Also accept createdTo alongside createdFrom
  let createdToRange = null;
  if (req.query.createdTo) {
    try {
      createdToRange = parseRange(`lte:${req.query.createdTo}`);
    } catch {
      return errorResponse(res, 400, 'INVALID_RANGE_FORMAT',
        'createdTo parameter is malformed');
    }
  }

  // Merge ranges
  const mergedCreatedRange = (createdRange || createdToRange)
    ? { ...(createdRange || {}), ...(createdToRange || {}) }
    : null;

  // Parse mimeType list
  const mimeTypes = mimeType
    ? mimeType.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : null;

  const results = [];

  for (const att of db.searchAttachments.values()) {
    // Tokenised filename match
    if (q && !fulltextMatch(att.filename, q) && !keywordPrefixMatch(att.filename, q)) continue;

    // mimeType exact match (OR semantics across list)
    if (mimeTypes && mimeTypes.length > 0) {
      const attMime = (att.mimeType || '').toLowerCase();
      if (!mimeTypes.some(m => m === attMime)) continue;
    }

    // created range
    if (!matchesRange(att.created, mergedCreatedRange)) continue;

    // issueId filter
    if (issueId && att.issueId !== issueId) continue;

    results.push({
      id: att.id,
      filename: att.filename,
      mimeType: att.mimeType,
      sizeBytes: att.sizeBytes || 0,
      created: att.created,
      issueId: att.issueId,
      issueKey: att.issueKey,
      storageKey: att.storageKey || null,
    });
  }

  // Sort by filename ASC, then id ASC
  results.sort((a, b) => {
    const nc = a.filename.localeCompare(b.filename);
    return nc !== 0 ? nc : a.id.localeCompare(b.id);
  });

  const { items, nextCursor } = paginateResults(results, limit, cursor, item => item.filename);

  return res.status(200).json({
    results: items,
    total: results.length,
    nextCursor,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/search/boards-sprints
// ---------------------------------------------------------------------------
router.get('/boards-sprints', (req, res) => {
  const { q, cursor } = req.query;
  const limit = parseLimit(req.query.limit);

  // Parse sprintState filter
  const sprintState = req.query.sprintState || req.query.state;
  let sprintStates = null;
  if (sprintState) {
    const states = sprintState.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    for (const s of states) {
      if (!VALID_SPRINT_STATES.has(s)) {
        return errorResponse(res, 400, 'INVALID_SPRINT_STATE',
          `sprintState must be one of: ${[...VALID_SPRINT_STATES].join(', ')}`);
      }
    }
    sprintStates = new Set(states);
  }

  // Parse dateFrom / dateTo range
  let dateRange = null;
  if (req.query.dateFrom || req.query.dateTo) {
    const parts = [];
    if (req.query.dateFrom) parts.push(`gte:${req.query.dateFrom}`);
    if (req.query.dateTo) parts.push(`lte:${req.query.dateTo}`);
    try {
      dateRange = parseRange(parts.join(','));
    } catch {
      return errorResponse(res, 400, 'INVALID_RANGE_FORMAT',
        'dateFrom/dateTo range parameter is malformed');
    }
  }

  const results = [];

  // Search boards
  for (const board of db.searchBoards.values()) {
    if (q && !fulltextMatch(board.name, q)) continue;
    // Boards don't have state or date — only include when no state/date filter
    if (sprintStates || dateRange) continue; // skip boards when sprint filters active

    results.push({
      id: board.id,
      type: 'board',
      name: board.name,
      boardType: board.type || null,
      projectKey: board.projectKey || null,
      sprintCount: board.sprintCount || 0,
    });
  }

  // Search sprints
  for (const sprint of db.searchSprints.values()) {
    if (q && !fulltextMatch(sprint.name, q)) continue;

    // State filter
    if (sprintStates && !sprintStates.has((sprint.state || '').toLowerCase())) continue;

    // Date range — match against startDate or endDate
    if (dateRange) {
      const startMatches = matchesRange(sprint.startDate, dateRange);
      const endMatches = matchesRange(sprint.endDate, dateRange);
      if (!startMatches && !endMatches) continue;
    }

    results.push({
      id: sprint.id,
      type: 'sprint',
      name: sprint.name,
      state: sprint.state,
      boardId: sprint.boardId || null,
      startDate: sprint.startDate || null,
      endDate: sprint.endDate || null,
      completeDate: sprint.completeDate || null,
      issueCount: sprint.issueCount || 0,
    });
  }

  // Sort by name ASC, then id ASC
  results.sort((a, b) => {
    const nc = a.name.localeCompare(b.name);
    return nc !== 0 ? nc : a.id.localeCompare(b.id);
  });

  const { items, nextCursor } = paginateResults(results, limit, cursor, item => item.name);

  return res.status(200).json({
    results: items,
    total: results.length,
    nextCursor,
  });
});

module.exports = router;
