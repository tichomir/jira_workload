# Resilience Module — Protected Object Inventory Architecture

_Sprint 6 | 2026-04-30 | Author: software_architect_

---

## 1. Overview

The Resilience Module surfaces a Protected Object Inventory sidebar that lets operators inspect three categories of Jira objects: Projects (`JiraProjectNode`), Workflows (`JiraWorkflowNode`), and Custom Fields (`JiraCustomFieldNode`). A platform-layer purge cascade boundary — already enforced by `services/purgeCascade.js` — ensures that `JiraWorkflowNode`, `JiraCustomFieldDefinitionNode`, and `JiraCustomFieldContextNode` can never be swept by a project- or backup-point-scoped purge, regardless of basket composition.

---

## 2. Sidebar Item Model

### 2.1 SidebarItem interface

```ts
interface SidebarItem {
  id: string;                    // e.g. "projects" | "workflows" | "custom-fields"
  label: string;                 // Display name
  nodeType: InventoryNodeType;   // Discriminant used by the inventory grid
  defaultSelected: boolean;      // Only ONE item may be true
  purgeProtected: boolean;       // true → shows lock indicator
  icon: string;                  // Icon key: "folder" | "flow" | "fields"
}

type InventoryNodeType =
  | 'JiraProjectNode'
  | 'JiraWorkflowNode'
  | 'JiraCustomFieldNode';
```

### 2.2 Static sidebar item registry

| id | label | nodeType | defaultSelected | purgeProtected | icon |
|----|-------|----------|-----------------|----------------|------|
| `projects` | Projects | `JiraProjectNode` | **true** | false | `folder` |
| `workflows` | Workflows | `JiraWorkflowNode` | false | **true** | `flow` |
| `custom-fields` | Custom Fields | `JiraCustomFieldNode` | false | **true** | `fields` |

`defaultSelected: true` is set exclusively on `projects`. The frontend reads this registry at mount time and activates the first item where `defaultSelected === true`.

---

## 3. Inventory Grid Column Contract (T8 §3)

Each object type renders a distinct column set. All grids share three **universal** columns; the remainder are type-specific.

### 3.1 Universal columns (all three grids)

| Column key | Header | Type | Sortable | Notes |
|------------|--------|------|----------|-------|
| `name` | Name | `string` | yes | Primary identifier; hyperlinks to detail view |
| `cloudSite` | Cloud Site | `string` | yes | Human-readable site name from `OAuthConnection.siteName` |
| `lastBackupAt` | Last Backup | `datetime` | yes | ISO-8601, rendered relative (e.g. "3 h ago") |

### 3.2 JiraProjectNode columns

| Column key | Header | Type | Sortable | Notes |
|------------|--------|------|----------|-------|
| `projectKey` | Key | `string` | yes | Jira project key, e.g. `PROJ` |
| `projectTypeKey` | Type | `enum` | yes | `software` \| `business` \| `service_desk` |
| `archived` | Archived | `boolean` | yes | Rendered as badge: "Archived" / "—" |
| `issueCount` | Issues | `number` | yes | Count of `JiraIssueNode` records in latest backup |
| `backupPointCount` | Backup Points | `number` | yes | Number of retained backup points |

Full column order: `name`, `projectKey`, `projectTypeKey`, `cloudSite`, `archived`, `issueCount`, `backupPointCount`, `lastBackupAt`.

### 3.3 JiraWorkflowNode columns

| Column key | Header | Type | Sortable | Notes |
|------------|--------|------|----------|-------|
| `workflowId` | Workflow ID | `string` | no | Internal Jira workflow ID |
| `stepCount` | Steps | `number` | yes | Number of statuses/steps in workflow |
| `isDefault` | Default | `boolean` | yes | Rendered as badge: "Default" / "—" |
| `purgeProtectedBadge` | Protection | `static` | no | Always renders lock icon + "Protected" label |

Full column order: `name`, `cloudSite`, `workflowId`, `stepCount`, `isDefault`, `purgeProtectedBadge`, `lastBackupAt`.

### 3.4 JiraCustomFieldNode columns

| Column key | Header | Type | Sortable | Notes |
|------------|--------|------|----------|-------|
| `fieldId` | Field ID | `string` | no | Jira custom field ID, e.g. `customfield_10001` |
| `fieldType` | Type | `string` | yes | Jira field type key |
| `contextCount` | Contexts | `number` | yes | Number of `JiraCustomFieldContextNode` records |
| `purgeProtectedBadge` | Protection | `static` | no | Always renders lock icon + "Protected" label |

Full column order: `name`, `cloudSite`, `fieldId`, `fieldType`, `contextCount`, `purgeProtectedBadge`, `lastBackupAt`.

---

## 4. Platform-Layer Purge Cascade Exclusion Boundary

### 4.1 Existing enforcement

`src/services/purgeCascade.js` already implements the boundary via:

```js
const PURGE_EXCLUDED_NODE_TYPES = new Set([
  'JiraWorkflowNode',
  'JiraCustomFieldDefinitionNode',
  'JiraCustomFieldContextNode',
]);

function assertPurgeCascadeAllowed(nodeType) { /* throws 409 on violation */ }
function isPurgeCascadeExcluded(nodeType)    { /* returns boolean */ }
```

`src/app.js` calls `assertPurgeCascadeAllowed(nodeType)` at `POST /api/v1/purge/cascade` **before** any cascade logic executes. This is a hard, platform-level gate — not a UI advisory.

### 4.2 Enforcement contract

```
┌─────────────────────────────────────────────────────────────────┐
│  POST /api/v1/purge/cascade  { nodeType, targetId }             │
│                                                                 │
│  1. assertPurgeCascadeAllowed(nodeType)                         │
│     ├─ nodeType in PURGE_EXCLUDED_NODE_TYPES?                   │
│     │   └─ YES → 409 PURGE_CASCADE_BOUNDARY_VIOLATION (throw)  │
│     └─ NO  → continue to cascade execution                     │
└─────────────────────────────────────────────────────────────────┘
```

The boundary is enforced **regardless of basket composition**. Even if a purge basket nominally targets a project, the cascade engine must call `assertPurgeCascadeAllowed` for every node type it would touch before executing any delete. Excluded types are silently skipped by the cascade iterator — they are never included in the deletion manifest.

### 4.3 Cascade iterator skip rule

When a cascade operation builds its deletion manifest, it MUST:

1. Enumerate candidate node types from the basket.
2. For each candidate, call `isPurgeCascadeExcluded(nodeType)`.
3. If `true` → remove from manifest; log a `PURGE_CASCADE_SKIP` audit event.
4. If `false` → include in manifest for deletion.

This ensures the boundary cannot be bypassed by composing a basket that indirectly references excluded types.

### 4.4 Scope of excluded types

| Node Type | Reason for exclusion |
|-----------|----------------------|
| `JiraWorkflowNode` | Site-scoped; shared across all projects in a cloudId |
| `JiraCustomFieldDefinitionNode` | Site-scoped; field definitions apply globally |
| `JiraCustomFieldContextNode` | Child of definition; deleting would corrupt field schemas |

`JiraCustomFieldNode` (the UI-facing inventory type) maps to `JiraCustomFieldDefinitionNode` at the data layer. The exclusion boundary covers both labels.

---

## 5. UI Protection Indicator Contract

### 5.1 Sidebar items

Sidebar items where `purgeProtected === true` render:

- A **lock icon** (`🔒` or SVG equivalent) to the right of the item label.
- On hover: tooltip text — `"Protected from purge cascade"`.

### 5.2 Grid rows (Workflows and Custom Fields grids)

The `purgeProtectedBadge` column (column key defined in §3.3 and §3.4) renders on every row:

| Element | Value |
|---------|-------|
| Icon | Lock icon (16 px) |
| Badge label | `"Protected"` |
| Colour token | `--color-warning-subtle` (amber, non-alarming) |
| Tooltip | `"This object type is excluded from purge cascade operations"` |

The badge is **static** — it appears on every row in these grids, not conditionally. Its presence communicates a type-level guarantee, not a per-object state.

### 5.3 Purge cascade request rejection (API response surface)

When `POST /api/v1/purge/cascade` is called with a protected type, the 409 response is:

```json
{
  "error": "PURGE_CASCADE_BOUNDARY_VIOLATION",
  "message": "Purge cascade is not allowed for node type \"JiraWorkflowNode\". Site-scoped objects are excluded from project-level purge cascades.",
  "nodeType": "JiraWorkflowNode"
}
```

The frontend must surface this as a non-dismissible error banner: _"[NodeType] objects are protected and cannot be included in purge cascade operations."_

---

## 6. Component Diagram

```
┌───────────────────────────────────────────────────────────────────┐
│  Resilience Module (Page)                                         │
│                                                                   │
│  ┌─────────────────────────┐   ┌──────────────────────────────┐  │
│  │  InventorySidebar        │   │  InventoryGrid               │  │
│  │                          │   │                              │  │
│  │  ● Projects  [default]   │   │  Renders column set from     │  │
│  │  🔒 Workflows            │──▶│  COLUMN_REGISTRY[nodeType]   │  │
│  │  🔒 Custom Fields        │   │                              │  │
│  │                          │   │  Rows sourced from           │  │
│  │  SidebarItem[]           │   │  GET /api/v1/resilience/     │  │
│  │  from SIDEBAR_REGISTRY   │   │    inventory?nodeType=...    │  │
│  └─────────────────────────┘   └──────────────────────────────┘  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘

Platform layer (service)
┌───────────────────────────────────────────────────────────────────┐
│  POST /api/v1/purge/cascade                                       │
│    └─ assertPurgeCascadeAllowed(nodeType)  [purgeCascade.js]      │
│         ├─ PURGE_EXCLUDED_NODE_TYPES.has(nodeType) → 409          │
│         └─ else → cascade execution                               │
└───────────────────────────────────────────────────────────────────┘
```

---

## 7. API Contract

### GET /api/v1/resilience/inventory

Returns paginated inventory rows for the specified node type.

**Request**

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `nodeType` | string | yes | `JiraProjectNode` \| `JiraWorkflowNode` \| `JiraCustomFieldNode` |
| `cloudId` | string | no | Filter by cloud site |
| `page` | number | no | 1-based, default 1 |
| `pageSize` | number | no | Default 25, max 100 |
| `sort` | string | no | Column key, e.g. `name` |
| `order` | string | no | `asc` \| `desc` |

**Success response — 200**

```json
{
  "nodeType": "JiraWorkflowNode",
  "page": 1,
  "pageSize": 25,
  "total": 42,
  "purgeProtected": true,
  "items": [
    {
      "id": "uuid",
      "name": "Software Development Workflow",
      "cloudSite": "my-company.atlassian.net",
      "workflowId": "software-dev",
      "stepCount": 6,
      "isDefault": false,
      "lastBackupAt": "2026-04-30T10:00:00Z"
    }
  ]
}
```

**Error codes**

| Code | HTTP | Meaning |
|------|------|---------|
| `INVALID_NODE_TYPE` | 400 | `nodeType` not in allowed set |
| `INTEGRATION_NOT_FOUND` | 404 | No active integration for `cloudId` |

---

## 8. Architecture Decision Records

### ADR-RES-001: Static sidebar registry over dynamic discovery

**Decision:** Sidebar items are defined as a static registry, not dynamically generated from available node types.

**Rationale:** The three object types (Projects, Workflows, Custom Fields) are fixed by product scope. Dynamic discovery adds complexity without value; it would also obscure the `defaultSelected` and `purgeProtected` semantics that are architectural guarantees.

**Consequences:** Adding a fourth sidebar item requires a registry change and a re-deploy. Acceptable given the stable scope.

---

### ADR-RES-002: purgeProtected flag is a type-level property, not a per-object property

**Decision:** `purgeProtected` is set on the sidebar item (node type level), not on individual rows.

**Rationale:** The exclusion is enforced at the service layer by `PURGE_EXCLUDED_NODE_TYPES`, which keys on `nodeType` strings. A per-row flag would imply per-object configurability that does not exist and could create false expectations.

**Consequences:** The `purgeProtectedBadge` column is always rendered for all rows in Workflows and Custom Fields grids. There is no mechanism to mark a specific workflow as "not protected".

---

### ADR-RES-003: Purge cascade boundary enforced at service layer, UI is informational only

**Decision:** The lock icon and "Protected" badge in the UI are informational. The authoritative enforcement is `assertPurgeCascadeAllowed` in `purgeCascade.js`.

**Rationale:** Relying on the UI to prevent purge cascade attempts would create a false safety guarantee. The platform layer must independently reject violations so that API clients (scripts, other services) also respect the boundary.

**Consequences:** If the UI fails to show the badge, the backend still rejects the request. The UI badge is a UX affordance, not a security control.

---

### ADR-RES-004: JiraCustomFieldNode (UI label) maps to JiraCustomFieldDefinitionNode (data label)

**Decision:** The sidebar item uses `JiraCustomFieldNode` as its `nodeType` for display purposes, but the purge boundary covers `JiraCustomFieldDefinitionNode` and `JiraCustomFieldContextNode`.

**Rationale:** The inventory grid surfaces the definition-level view to users. The additional `JiraCustomFieldContextNode` exclusion is a data-layer detail that does not need a separate sidebar entry; it is documented here and enforced in `PURGE_EXCLUDED_NODE_TYPES`.

**Consequences:** Frontend code mapping `JiraCustomFieldNode` → API queries must translate to the correct data-layer type. The backend `GET /api/v1/resilience/inventory?nodeType=JiraCustomFieldNode` handler is responsible for this translation.
