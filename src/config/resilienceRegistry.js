'use strict';

/**
 * Resilience Module — Static Configuration
 * Sprint 6 | 2026-04-30
 *
 * Provides three pure-config objects consumed by the backend resilience routes
 * and (via shared-types) the frontend:
 *   1. SIDEBAR_REGISTRY    — three fixed sidebar entries
 *   2. COLUMN_REGISTRY     — column definitions per node type (T8 §3)
 *   3. PURGE_EXCLUDED_NODE_TYPES — mirror of purgeCascade.js constant,
 *      re-exported here so config-only consumers don't need to import from
 *      services/. The authoritative enforcement remains in purgeCascade.js.
 *
 * No business logic lives here — only static shape definitions.
 */

// ---------------------------------------------------------------------------
// 1. Sidebar item registry (ADR-RES-001)
// ---------------------------------------------------------------------------

/**
 * @type {ReadonlyArray<{
 *   id: string,
 *   label: string,
 *   nodeType: string,
 *   defaultSelected: boolean,
 *   purgeProtected: boolean,
 *   icon: string,
 * }>}
 */
const SIDEBAR_REGISTRY = Object.freeze([
  {
    id: 'projects',
    label: 'Projects',
    nodeType: 'JiraProjectNode',
    defaultSelected: true,
    purgeProtected: false,
    icon: 'folder',
  },
  {
    id: 'workflows',
    label: 'Workflows',
    nodeType: 'JiraWorkflowNode',
    defaultSelected: false,
    purgeProtected: true,
    icon: 'flow',
  },
  {
    id: 'custom-fields',
    label: 'Custom Fields',
    nodeType: 'JiraCustomFieldNode',
    defaultSelected: false,
    purgeProtected: true,
    icon: 'fields',
  },
]);

// ---------------------------------------------------------------------------
// 2. Column definitions per node type (T8 §3)
// ---------------------------------------------------------------------------

// Universal columns shared by all three grids (T8 §3.1)
const _NAME_COL        = Object.freeze({ id: 'name',         label: 'Name',        type: 'string',   sortable: true,  defaultVisible: true });
const _CLOUD_SITE_COL  = Object.freeze({ id: 'cloudSite',    label: 'Cloud Site',  type: 'string',   sortable: true,  defaultVisible: true });
const _LAST_BACKUP_COL = Object.freeze({ id: 'lastBackupAt', label: 'Last Backup', type: 'datetime', sortable: true,  defaultVisible: true });

/**
 * JiraProjectNode columns — T8 §3.2
 * Order: name, projectKey, projectTypeKey, cloudSite, archived,
 *        issueCount, backupPointCount, lastBackupAt
 */
const PROJECT_COLUMNS = Object.freeze([
  _NAME_COL,
  Object.freeze({ id: 'projectKey',      label: 'Key',           type: 'string',  sortable: true,  defaultVisible: true }),
  Object.freeze({ id: 'projectTypeKey',  label: 'Type',          type: 'enum',    sortable: true,  defaultVisible: true }),
  _CLOUD_SITE_COL,
  Object.freeze({ id: 'archived',        label: 'Archived',      type: 'boolean', sortable: true,  defaultVisible: true }),
  Object.freeze({ id: 'issueCount',      label: 'Issues',        type: 'number',  sortable: true,  defaultVisible: true }),
  Object.freeze({ id: 'backupPointCount',label: 'Backup Points', type: 'number',  sortable: true,  defaultVisible: true }),
  _LAST_BACKUP_COL,
]);

/**
 * JiraWorkflowNode columns — T8 §3.3
 * Order: name, cloudSite, workflowId, stepCount, isDefault,
 *        purgeProtectedBadge, lastBackupAt
 */
const WORKFLOW_COLUMNS = Object.freeze([
  _NAME_COL,
  _CLOUD_SITE_COL,
  Object.freeze({ id: 'workflowId',          label: 'Workflow ID', type: 'string',  sortable: false, defaultVisible: true }),
  Object.freeze({ id: 'stepCount',           label: 'Steps',       type: 'number',  sortable: true,  defaultVisible: true }),
  Object.freeze({ id: 'isDefault',           label: 'Default',     type: 'boolean', sortable: true,  defaultVisible: true }),
  Object.freeze({ id: 'purgeProtectedBadge', label: 'Protection',  type: 'static',  sortable: false, defaultVisible: true }),
  _LAST_BACKUP_COL,
]);

/**
 * JiraCustomFieldNode columns — T8 §3.4
 * Order: name, cloudSite, fieldId, fieldType, contextCount,
 *        purgeProtectedBadge, lastBackupAt
 */
const CUSTOM_FIELD_COLUMNS = Object.freeze([
  _NAME_COL,
  _CLOUD_SITE_COL,
  Object.freeze({ id: 'fieldId',             label: 'Field ID',   type: 'string',  sortable: false, defaultVisible: true }),
  Object.freeze({ id: 'fieldType',           label: 'Type',       type: 'string',  sortable: true,  defaultVisible: true }),
  Object.freeze({ id: 'contextCount',        label: 'Contexts',   type: 'number',  sortable: true,  defaultVisible: true }),
  Object.freeze({ id: 'purgeProtectedBadge', label: 'Protection', type: 'static',  sortable: false, defaultVisible: true }),
  _LAST_BACKUP_COL,
]);

/**
 * Column registry keyed by InventoryNodeType.
 * Usage: COLUMN_REGISTRY[nodeType] → ColumnDefinition[]
 *
 * @type {Readonly<Record<string, ReadonlyArray<object>>>}
 */
const COLUMN_REGISTRY = Object.freeze({
  JiraProjectNode:    PROJECT_COLUMNS,
  JiraWorkflowNode:   WORKFLOW_COLUMNS,
  JiraCustomFieldNode: CUSTOM_FIELD_COLUMNS,
});

// ---------------------------------------------------------------------------
// 3. Purge cascade exclusion registry (mirrors purgeCascade.js)
// ---------------------------------------------------------------------------

/**
 * Frozen set of node types excluded from purge cascade at the platform layer.
 *
 * This constant is a config-layer reference copy.
 * The AUTHORITATIVE enforcement gate is assertPurgeCascadeAllowed() in
 * src/services/purgeCascade.js — that file's Set must remain in sync with this one.
 *
 * Includes both data-layer labels (JiraCustomFieldDefinitionNode,
 * JiraCustomFieldContextNode) and the UI-layer label (JiraWorkflowNode).
 * JiraCustomFieldNode is the UI label for JiraCustomFieldDefinitionNode;
 * it is NOT in this set because the purge service keys on data-layer types.
 *
 * @type {ReadonlySet<string>}
 */
const PURGE_EXCLUDED_NODE_TYPES = Object.freeze(
  new Set([
    'JiraWorkflowNode',
    'JiraCustomFieldDefinitionNode',
    'JiraCustomFieldContextNode',
  ])
);

/** Valid InventoryNodeType values for API input validation. */
const INVENTORY_NODE_TYPES = Object.freeze([
  'JiraProjectNode',
  'JiraWorkflowNode',
  'JiraCustomFieldNode',
]);

module.exports = {
  SIDEBAR_REGISTRY,
  COLUMN_REGISTRY,
  PROJECT_COLUMNS,
  WORKFLOW_COLUMNS,
  CUSTOM_FIELD_COLUMNS,
  PURGE_EXCLUDED_NODE_TYPES,
  INVENTORY_NODE_TYPES,
};
