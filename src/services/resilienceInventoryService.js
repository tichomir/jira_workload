'use strict';

/**
 * Sprint 6 — Resilience Module Inventory Service
 *
 * Returns paginated inventory rows for each protected object type.
 * Reads from the in-memory db where data exists; falls back to deterministic
 * stub rows in empty/test environments.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function _clampPagination(page, pageSize) {
  return {
    pg: Math.max(1, parseInt(page, 10) || 1),
    ps: Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(pageSize, 10) || DEFAULT_PAGE_SIZE)),
  };
}

function _paginate(rows, pg, ps) {
  const offset = (pg - 1) * ps;
  return rows.slice(offset, offset + ps);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

function getProjectInventory({ page = 1, pageSize = DEFAULT_PAGE_SIZE, cloudId } = {}) {
  const { pg, ps } = _clampPagination(page, pageSize);

  let rows = [];
  for (const node of db.projectNodes.values()) {
    if (cloudId && node.cloudId !== cloudId) continue;
    rows.push({
      id: node.id || uuidv4(),
      name: node.name || node.key || 'Unknown Project',
      cloudSite: node.cloudSite || node.cloudId || 'default-site',
      projectKey: node.key || node.projectKey || '',
      projectTypeKey: node.projectTypeKey || 'software',
      archived: node.archived || false,
      issueCount: node.issueCount || 0,
      backupPointCount: node.backupPointCount || 0,
      lastBackupAt: node.lastBackupAt || new Date().toISOString(),
      purgeProtected: false,
    });
  }

  if (rows.length === 0) {
    rows = _stubProjectRows(cloudId);
  }

  return {
    nodeType: 'JiraProjectNode',
    page: pg,
    pageSize: ps,
    total: rows.length,
    purgeProtected: false,
    items: _paginate(rows, pg, ps),
  };
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

function getWorkflowInventory({ page = 1, pageSize = DEFAULT_PAGE_SIZE, cloudId } = {}) {
  const { pg, ps } = _clampPagination(page, pageSize);

  let rows = [];
  for (const node of db.workflowNodes.values()) {
    if (cloudId && node.cloudId !== cloudId) continue;
    rows.push({
      id: node.id || uuidv4(),
      name: node.name || 'Unnamed Workflow',
      cloudSite: node.cloudSite || node.cloudId || 'default-site',
      workflowId: node.workflowId || node.id || uuidv4(),
      stepCount: node.stepCount || 0,
      isDefault: node.isDefault || false,
      lastBackupAt: node.lastBackupAt || new Date().toISOString(),
      purgeProtected: true,
    });
  }

  if (rows.length === 0) {
    rows = _stubWorkflowRows(cloudId);
  }

  return {
    nodeType: 'JiraWorkflowNode',
    page: pg,
    pageSize: ps,
    total: rows.length,
    purgeProtected: true,
    items: _paginate(rows, pg, ps),
  };
}

// ---------------------------------------------------------------------------
// Custom Fields
// ---------------------------------------------------------------------------

function getCustomFieldInventory({ page = 1, pageSize = DEFAULT_PAGE_SIZE, cloudId } = {}) {
  const { pg, ps } = _clampPagination(page, pageSize);

  let rows = [];
  for (const node of db.customFieldDefinitions.values()) {
    if (cloudId && node.cloudId !== cloudId) continue;
    let contextCount = 0;
    for (const ctx of db.customFieldContextNodes.values()) {
      if (ctx.fieldId === (node.fieldId || node.id)) contextCount++;
    }
    rows.push({
      id: node.id || uuidv4(),
      name: node.name || 'Unnamed Field',
      cloudSite: node.cloudSite || node.cloudId || 'default-site',
      fieldId: node.fieldId || node.id || uuidv4(),
      fieldType: (node.schema && node.schema.type) || node.fieldType || 'string',
      contextCount,
      lastBackupAt: node.lastBackupAt || new Date().toISOString(),
      purgeProtected: true,
    });
  }

  if (rows.length === 0) {
    rows = _stubCustomFieldRows(cloudId);
  }

  return {
    nodeType: 'JiraCustomFieldNode',
    page: pg,
    pageSize: ps,
    total: rows.length,
    purgeProtected: true,
    items: _paginate(rows, pg, ps),
  };
}

// ---------------------------------------------------------------------------
// Deterministic stubs (used when db maps are empty)
// ---------------------------------------------------------------------------

function _stubProjectRows(cloudId) {
  const site = cloudId || 'stub-site.atlassian.net';
  return [
    { id: 'proj-1', name: 'ACME Platform', cloudSite: site, projectKey: 'ACME', projectTypeKey: 'software', archived: false, issueCount: 142, backupPointCount: 7, lastBackupAt: '2026-04-30T12:00:00Z', purgeProtected: false },
    { id: 'proj-2', name: 'Marketing Site', cloudSite: site, projectKey: 'MKTG', projectTypeKey: 'business', archived: false, issueCount: 34, backupPointCount: 3, lastBackupAt: '2026-04-29T08:00:00Z', purgeProtected: false },
    { id: 'proj-3', name: 'Legacy Portal', cloudSite: site, projectKey: 'LEG', projectTypeKey: 'software', archived: true, issueCount: 890, backupPointCount: 12, lastBackupAt: '2026-04-28T06:00:00Z', purgeProtected: false },
  ];
}

function _stubWorkflowRows(cloudId) {
  const site = cloudId || 'stub-site.atlassian.net';
  return [
    { id: 'wf-1', name: 'Software Development', cloudSite: site, workflowId: 'wf-software-dev', stepCount: 5, isDefault: true, lastBackupAt: '2026-04-30T12:00:00Z', purgeProtected: true },
    { id: 'wf-2', name: 'Bug Triage', cloudSite: site, workflowId: 'wf-bug-triage', stepCount: 4, isDefault: false, lastBackupAt: '2026-04-30T12:00:00Z', purgeProtected: true },
  ];
}

function _stubCustomFieldRows(cloudId) {
  const site = cloudId || 'stub-site.atlassian.net';
  return [
    { id: 'cf-1', name: 'Story Points', cloudSite: site, fieldId: 'customfield_10016', fieldType: 'number', contextCount: 2, lastBackupAt: '2026-04-30T12:00:00Z', purgeProtected: true },
    { id: 'cf-2', name: 'Epic Link', cloudSite: site, fieldId: 'customfield_10014', fieldType: 'string', contextCount: 1, lastBackupAt: '2026-04-30T12:00:00Z', purgeProtected: true },
    { id: 'cf-3', name: 'Sprint', cloudSite: site, fieldId: 'customfield_10020', fieldType: 'array', contextCount: 3, lastBackupAt: '2026-04-29T10:00:00Z', purgeProtected: true },
  ];
}

module.exports = {
  getProjectInventory,
  getWorkflowInventory,
  getCustomFieldInventory,
};
