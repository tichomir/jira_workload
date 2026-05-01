/**
 * Resilience Module — Protected Object Inventory Shared Types
 * Sprint 6 | 2026-04-30
 *
 * Consumed by the backend resilience routes/services and the frontend
 * Resilience Module UI (sidebar + inventory grid).
 *
 * Key decisions:
 *   - Sidebar registry is static (ADR-RES-001).
 *   - purgeProtected is a type-level flag, not per-object (ADR-RES-002).
 *   - JiraCustomFieldNode (UI) maps to JiraCustomFieldDefinitionNode at data layer (ADR-RES-004).
 */

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

/** Discriminant node types exposed in the Resilience Module sidebar. */
export type InventoryNodeType =
  | 'JiraProjectNode'
  | 'JiraWorkflowNode'
  | 'JiraCustomFieldNode';

/**
 * Platform-layer purge cascade excluded node types.
 * Covers both the data-layer labels consumed by purgeCascade.js and the
 * UI-layer label JiraCustomFieldNode (see ADR-RES-004).
 */
export type PurgeCascadeExcludedNodeType =
  | 'JiraWorkflowNode'
  | 'JiraCustomFieldDefinitionNode'
  | 'JiraCustomFieldContextNode';

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

/** A single entry in the Resilience Module sidebar. */
export interface SidebarItem {
  /** Stable slug used as React key and URL param. */
  id: 'projects' | 'workflows' | 'custom-fields';
  /** Display name shown in sidebar. */
  label: string;
  /** Discriminant forwarded to inventory grid and API. */
  nodeType: InventoryNodeType;
  /** Exactly one item in the registry has this set to true. */
  defaultSelected: boolean;
  /** When true, sidebar renders lock icon + "Protected from purge cascade" tooltip. */
  purgeProtected: boolean;
  /** Icon key resolved by the UI icon registry. */
  icon: 'folder' | 'flow' | 'fields';
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

export type ColumnType = 'string' | 'number' | 'boolean' | 'datetime' | 'enum' | 'static';

/** A single column definition for the inventory grid. */
export interface ColumnDefinition {
  /** Unique key within the column set; maps to the data field path. */
  id: string;
  /** Column header label. */
  label: string;
  /** Data type — used for rendering and sort behaviour. */
  type: ColumnType;
  /** Whether the column supports server-side sorting. */
  sortable: boolean;
  /** Whether the column is visible in the default column configuration. */
  defaultVisible: boolean;
}

// ---------------------------------------------------------------------------
// Purge cascade exclusion registry constant
// ---------------------------------------------------------------------------

/**
 * Immutable set of node types excluded from purge cascade at the platform layer.
 * Mirror of PURGE_EXCLUDED_NODE_TYPES in src/services/purgeCascade.js.
 * Both must remain in sync.
 */
export const PURGE_CASCADE_EXCLUDED_NODE_TYPES: ReadonlySet<PurgeCascadeExcludedNodeType> =
  new Set<PurgeCascadeExcludedNodeType>([
    'JiraWorkflowNode',
    'JiraCustomFieldDefinitionNode',
    'JiraCustomFieldContextNode',
  ]);

// ---------------------------------------------------------------------------
// Sidebar item registry
// ---------------------------------------------------------------------------

/**
 * Static sidebar registry — three fixed entries matching product scope.
 * The frontend reads this at mount time and activates the first item
 * where defaultSelected === true.
 */
export const SIDEBAR_REGISTRY: ReadonlyArray<SidebarItem> = Object.freeze([
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
] as const);

// ---------------------------------------------------------------------------
// Column registry
// ---------------------------------------------------------------------------

/** Universal columns shared by all three inventory grids (T8 §3.1). */
const UNIVERSAL_COLUMNS: ReadonlyArray<ColumnDefinition> = Object.freeze([
  {
    id: 'name',
    label: 'Name',
    type: 'string',
    sortable: true,
    defaultVisible: true,
  },
  {
    id: 'cloudSite',
    label: 'Cloud Site',
    type: 'string',
    sortable: true,
    defaultVisible: true,
  },
  {
    id: 'lastBackupAt',
    label: 'Last Backup',
    type: 'datetime',
    sortable: true,
    defaultVisible: true,
  },
]);

/**
 * Column definitions for JiraProjectNode grid (T8 §3.2).
 * Order: name, projectKey, projectTypeKey, cloudSite, archived, issueCount,
 *        backupPointCount, lastBackupAt.
 */
export const PROJECT_COLUMNS: ReadonlyArray<ColumnDefinition> = Object.freeze([
  UNIVERSAL_COLUMNS[0], // name
  {
    id: 'projectKey',
    label: 'Key',
    type: 'string',
    sortable: true,
    defaultVisible: true,
  },
  {
    id: 'projectTypeKey',
    label: 'Type',
    type: 'enum',
    sortable: true,
    defaultVisible: true,
  },
  UNIVERSAL_COLUMNS[1], // cloudSite
  {
    id: 'archived',
    label: 'Archived',
    type: 'boolean',
    sortable: true,
    defaultVisible: true,
  },
  {
    id: 'issueCount',
    label: 'Issues',
    type: 'number',
    sortable: true,
    defaultVisible: true,
  },
  {
    id: 'backupPointCount',
    label: 'Backup Points',
    type: 'number',
    sortable: true,
    defaultVisible: true,
  },
  UNIVERSAL_COLUMNS[2], // lastBackupAt
]);

/**
 * Column definitions for JiraWorkflowNode grid (T8 §3.3).
 * Order: name, cloudSite, workflowId, stepCount, isDefault,
 *        purgeProtectedBadge, lastBackupAt.
 */
export const WORKFLOW_COLUMNS: ReadonlyArray<ColumnDefinition> = Object.freeze([
  UNIVERSAL_COLUMNS[0], // name
  UNIVERSAL_COLUMNS[1], // cloudSite
  {
    id: 'workflowId',
    label: 'Workflow ID',
    type: 'string',
    sortable: false,
    defaultVisible: true,
  },
  {
    id: 'stepCount',
    label: 'Steps',
    type: 'number',
    sortable: true,
    defaultVisible: true,
  },
  {
    id: 'isDefault',
    label: 'Default',
    type: 'boolean',
    sortable: true,
    defaultVisible: true,
  },
  {
    id: 'purgeProtectedBadge',
    label: 'Protection',
    type: 'static',
    sortable: false,
    defaultVisible: true,
  },
  UNIVERSAL_COLUMNS[2], // lastBackupAt
]);

/**
 * Column definitions for JiraCustomFieldNode grid (T8 §3.4).
 * Order: name, cloudSite, fieldId, fieldType, contextCount,
 *        purgeProtectedBadge, lastBackupAt.
 */
export const CUSTOM_FIELD_COLUMNS: ReadonlyArray<ColumnDefinition> = Object.freeze([
  UNIVERSAL_COLUMNS[0], // name
  UNIVERSAL_COLUMNS[1], // cloudSite
  {
    id: 'fieldId',
    label: 'Field ID',
    type: 'string',
    sortable: false,
    defaultVisible: true,
  },
  {
    id: 'fieldType',
    label: 'Type',
    type: 'string',
    sortable: true,
    defaultVisible: true,
  },
  {
    id: 'contextCount',
    label: 'Contexts',
    type: 'number',
    sortable: true,
    defaultVisible: true,
  },
  {
    id: 'purgeProtectedBadge',
    label: 'Protection',
    type: 'static',
    sortable: false,
    defaultVisible: true,
  },
  UNIVERSAL_COLUMNS[2], // lastBackupAt
]);

/**
 * Column registry keyed by InventoryNodeType.
 * The inventory grid reads COLUMN_REGISTRY[nodeType] to determine which
 * columns to render.
 */
export const COLUMN_REGISTRY: Readonly<Record<InventoryNodeType, ReadonlyArray<ColumnDefinition>>> =
  Object.freeze({
    JiraProjectNode: PROJECT_COLUMNS,
    JiraWorkflowNode: WORKFLOW_COLUMNS,
    JiraCustomFieldNode: CUSTOM_FIELD_COLUMNS,
  });

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

/** Query parameters for GET /api/v1/resilience/inventory */
export interface ResilienceInventoryRequest {
  nodeType: InventoryNodeType;
  cloudId?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  order?: 'asc' | 'desc';
}

/** Base inventory row fields (all node types). */
export interface InventoryRowBase {
  id: string;
  name: string;
  cloudSite: string;
  lastBackupAt: string;
}

/** Inventory row for JiraProjectNode. */
export interface ProjectInventoryRow extends InventoryRowBase {
  projectKey: string;
  projectTypeKey: 'software' | 'business' | 'service_desk';
  archived: boolean;
  issueCount: number;
  backupPointCount: number;
}

/** Inventory row for JiraWorkflowNode. */
export interface WorkflowInventoryRow extends InventoryRowBase {
  workflowId: string;
  stepCount: number;
  isDefault: boolean;
}

/** Inventory row for JiraCustomFieldNode. */
export interface CustomFieldInventoryRow extends InventoryRowBase {
  fieldId: string;
  fieldType: string;
  contextCount: number;
}

export type InventoryRow = ProjectInventoryRow | WorkflowInventoryRow | CustomFieldInventoryRow;

/** Success response for GET /api/v1/resilience/inventory */
export interface ResilienceInventoryResponse {
  nodeType: InventoryNodeType;
  page: number;
  pageSize: number;
  total: number;
  purgeProtected: boolean;
  items: InventoryRow[];
}

/** Error codes returned by the Resilience Module API. */
export type ResilienceErrorCode = 'INVALID_NODE_TYPE' | 'INTEGRATION_NOT_FOUND';
