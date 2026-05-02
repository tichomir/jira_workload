# Sprint 22 — Comprehensive Backup & Restore Coverage Design

**Date:** 2026-05-02  
**Author:** Software Architect  
**Status:** Approved for implementation

---

## 1. Executive Summary

This document addresses four coverage gaps identified in Sprint 22:

1. **Custom Fields** — ensure ALL 56 custom fields are enumerated and every issue backup captures the full `fields.*` payload.
2. **Boards & Sprints** — currently not backed up; define endpoints, schemas, and restore order.
3. **Attachments & Issue Links** — attachments are materialized but links are not captured; define full backup+restore for both.
4. **Restore Identity** — restored issues lack a clear reference to their origin; define the label + summary-prefix convention.

---

## 2. Gap Analysis Table

| Concern | Current State | Gap | Fix |
|---|---|---|---|
| Custom field enumeration | `GET /rest/api/3/field` enumerates all fields, contexts, options | Backup stores snapshot but JQL does not explicitly request all custom field values in issue payload | Explicitly pass `fields=*all` in JQL search params |
| Issue field payload | `raw` issue object stored, but via default field expansion | Some system-managed fields and rich custom field types may be absent | Add `fields=*all&expand=names,schema` to JQL params |
| Board backup | Not implemented — `boards: 0` hardcoded | No board enumeration in backup engine | Add board enumeration via Agile API |
| Sprint backup | Not implemented — `sprints: 0` hardcoded | No sprint enumeration | Add sprint enumeration per board |
| Attachment binary | Materialized via `attachmentMaterialisation.js` | Already working; issue link sub-records not captured | Add `issuelinks` to issue snapshot |
| Issue links | Not captured | `fields.issuelinks` never read or stored | Store `issuelinks` array in issue snapshot; restore via POST /issueLink |
| Restore identity | `original-key:PROJ-123` label applied | UI shows ID only; summary prefix missing | Prepend `[PROJ-123]` to restored issue summary |

---

## 3. Custom Fields — Full Coverage Design

### 3.1 Enumeration (already correct — verify completeness)

The existing `enumerateCustomFields` in `siteObjectEnumeration.js` calls:

```
GET /rest/api/3/field
```

Returns all system AND custom fields. Custom fields have `id` starting with `customfield_`. No change needed here — all 56 will be returned.

Custom field contexts and options are already enumerated via:

```
GET /rest/api/3/field/{fieldId}/context
GET /rest/api/3/field/{fieldId}/context/option
```

### 3.2 JiraCustomFieldDefinitionNode — JSON Schema

```json
{
  "id": "customfield_10020",
  "name": "Sprint",
  "type": "com.pyxis.greenhopper.jira:gh-sprint",
  "schema": {
    "type": "array",
    "items": "json",
    "custom": "com.pyxis.greenhopper.jira:gh-sprint",
    "customId": 10020
  },
  "contexts": [
    {
      "id": "10001",
      "name": "Default Context",
      "isGlobalContext": true,
      "isAnyIssueType": true,
      "options": []
    }
  ],
  "defaultValues": {},
  "configuration": {}
}
```

Required fields: `id` (string, not-null), `name` (string, not-null), `type` (string, nullable), `schema` (object, nullable), `contexts` (array, default `[]`), `defaultValues` (object, default `{}`), `configuration` (object, default `{}`).

### 3.3 Issue Field Payload — Full Capture Fix

**Current problem:** `fetchIssuePage` in `jqlEnumeration.js:70` does not pass a `fields` parameter, so Jira returns only "navigable" fields — a subset that omits some custom field types.

**Fix:** Add `fields: '*all'` and `expand: 'names,renderedFields'` to the JQL request params:

```js
// jqlEnumeration.js — fetchIssuePage params
params: {
  jql,
  startAt,
  maxResults: PAGE_SIZE,
  fields: '*all',          // request every field including custom
  expand: 'names',         // include field name→id mapping in response
}
```

**Issue snapshot schema** (stored in `objectSnapshots` / `db.issues`):

```json
{
  "id": "10035",
  "key": "KS-1",
  "projectKey": "KS",
  "summary": "Story 1",
  "issuetype": { "name": "Story", "id": "10001" },
  "status": { "name": "To Do", "statusCategory": { "key": "new" } },
  "priority": { "name": "Medium" },
  "assignee": { "accountId": "...", "displayName": "..." },
  "reporter": { "accountId": "...", "displayName": "..." },
  "labels": ["original-key:KS-1"],
  "created": "2026-05-01T10:00:00.000Z",
  "updated": "2026-05-02T08:00:00.000Z",
  "resolutiondate": null,
  "description": { "type": "doc", "version": 1, "content": [] },
  "comment": {
    "comments": [
      { "id": "10001", "body": { "type": "doc", "version": 1, "content": [] }, "author": { "accountId": "..." }, "created": "..." }
    ]
  },
  "attachment": [
    { "id": "10001", "filename": "file.png", "mimeType": "image/png", "size": 12345, "content": "https://..." }
  ],
  "issuelinks": [
    { "id": "10001", "type": { "name": "Blocks", "inward": "is blocked by", "outward": "blocks" }, "outwardIssue": { "key": "KS-2" } }
  ],
  "customfield_10020": [{ "id": 1, "name": "Sprint 1", "state": "active" }],
  "customfield_10014": "KS-0",
  "fields": { "_ALL_FIELDS_AS_RETURNED_BY_API_": "..." }
}
```

The `fields` property stores the raw `issue.fields` object verbatim — this is the full payload used on restore. Specific top-level fields (`summary`, `issuetype`, etc.) are extracted for indexing/search only.

---

## 4. Boards & Sprints Design

### 4.1 Backup Endpoints

**Boards:**

```
GET /rest/agile/1.0/board
  → params: startAt, maxResults=50
  → returns: { values: [...], isLast, startAt, maxResults }
  → fields: id, name, type (scrum|kanban), location.projectKey

GET /rest/agile/1.0/board/{boardId}/configuration
  → returns: filter.id (backing filter JQL), columnConfig, ranking
```

**Sprints (per board, scrum boards only):**

```
GET /rest/agile/1.0/board/{boardId}/sprint
  → params: startAt, maxResults=50, state=active,future,closed
  → returns: { values: [...], isLast }
  → fields: id, name, state, startDate, endDate, completeDate, goal
```

### 4.2 JiraBoardNode — JSON Schema

```json
{
  "nodeType": "JiraBoardNode",
  "id": 1,
  "name": "KS Board",
  "type": "kanban",
  "location": {
    "projectKey": "KS",
    "projectId": "10000"
  },
  "filterJql": "project = KS ORDER BY Rank ASC",
  "filterId": "10001",
  "columnConfig": {
    "columns": [
      { "name": "To Do", "statuses": [{ "id": "10000" }] },
      { "name": "Done",  "statuses": [{ "id": "10001" }] }
    ]
  }
}
```

Required fields: `id` (number, not-null), `name` (string, not-null), `type` (string, `scrum|kanban`), `location.projectKey` (string, not-null), `filterJql` (string, nullable), `columnConfig` (object, nullable).

### 4.3 JiraSprintNode — JSON Schema

```json
{
  "nodeType": "JiraSprintNode",
  "id": 1,
  "name": "Sprint 1",
  "state": "active",
  "boardId": 1,
  "startDate": "2026-05-01T00:00:00.000Z",
  "endDate": "2026-05-15T00:00:00.000Z",
  "completeDate": null,
  "goal": "Ship the MVP",
  "originBoardId": 1
}
```

Required fields: `id` (number, not-null), `name` (string, not-null), `state` (string: `active|future|closed`), `boardId` (number, not-null — source board at backup time), `startDate`/`endDate` (ISO string, nullable).

### 4.4 Board Backup Implementation

Add `enumerateBoards()` to `siteObjectEnumeration.js`:

```
1. GET /rest/agile/1.0/board (paginate isLast)
2. For each board: GET /rest/agile/1.0/board/{id}/configuration → store filterJql, columnConfig
3. For scrum boards: GET /rest/agile/1.0/board/{id}/sprint (paginate) → store all sprints
4. Store boards in db.objectSnapshots[backupPointId] under nodeType=JiraBoardNode
5. Store sprints in db.objectSnapshots[backupPointId] under nodeType=JiraSprintNode
```

`backupEngine.js` must update `objectCounts.boards` and `objectCounts.sprints` with real counts.

### 4.5 Restore Order & Dependencies

```
Stage 1: Workflows + CustomFieldDefinitions
Stage 2: Projects
Stage 3: Parent Issues  ← (epic issues restored before child issues)
Stage 4: Comments + Attachments + Boards   ← Board depends on Project existing
Stage 5: Sprints                           ← Sprint depends on Board existing
Stage 5b: Issue→Sprint association         ← After sprints created, move issues into sprints
```

**Board restore** (`POST /rest/agile/1.0/board`):

```json
{
  "name": "KS Board",
  "type": "kanban",
  "filterId": "<restored-filter-id-or-use-location-projectKey>",
  "location": { "type": "project", "projectKeyOrId": "KS" }
}
```

Note: Board creation via API uses a filter. When restoring to original location, a simple board can be created scoped to the project. The `filterId` from backup is a source-site artifact; on restore, create the board using `location.projectKey` and accept the Jira-generated default filter.

**Sprint restore** (`POST /rest/agile/1.0/sprint`):

```json
{
  "name": "Sprint 1",
  "originBoardId": "<targetBoardId>",
  "goal": "Ship the MVP",
  "startDate": "2026-05-01T00:00:00.000Z",
  "endDate": "2026-05-15T00:00:00.000Z"
}
```

Map `sourceSprintId → targetSprintId` in `restoreOrchestrator.sourceToBoardId` / `sourceToSprintId`. After all issues are created, move issues to their sprint via:

```
POST /rest/agile/1.0/sprint/{sprintId}/issue
{ "issues": ["KS-1", "KS-2"] }
```

Issue→Sprint association is derived from `fields.customfield_10020` (sprint array) in the issue snapshot. Collect per sprint, batch-move after sprint creation.

---

## 5. Attachments & Issue Links Design

### 5.1 Attachment Backup (existing — confirm complete)

`attachmentMaterialisation.js` already:
- Downloads binary via `GET /rest/api/3/attachment/content/{id}`
- Stores with checksum, sizeBytes, binaryStorageRef, mimeType
- Implements sidecar carry-forward (deduplication by attachmentId)

**No change needed for backup.** Confirm the attachment list is sourced from `issue.fields.attachment` (present in `*all` field expansion).

### 5.2 Attachment Restore

**Restore endpoint:**

```
POST /rest/api/3/issue/{issueIdOrKey}/attachments
Content-Type: multipart/form-data
X-Atlassian-Token: no-check
Body: file binary stream
```

**Attachment sub-record schema** (stored inside issue snapshot `fields.attachment[]`):

```json
{
  "id": "10001",
  "filename": "screenshot.png",
  "mimeType": "image/png",
  "size": 12345,
  "content": "https://...",
  "binaryStorageRef": "integrations/{integrationId}/attachments/10001",
  "checksum": "sha256:abcdef..."
}
```

**Restore flow:**

1. Retrieve binary from `binaryStorageRef` (local storage path).
2. `POST /rest/api/3/issue/{targetKey}/attachments` with binary stream.
3. Log `attachment_restored` with source `id` → new Jira attachment `id` mapping.
4. Respect 250 MB platform limit (already validated at pre-execution check).

### 5.3 Issue Links — Backup

Issue links are in `fields.issuelinks` returned by Jira. With `fields=*all` enabled (§3.3), they will be present in `issue.raw.fields.issuelinks`.

**Store issuelinks in issue snapshot:**

```json
"issuelinks": [
  {
    "id": "10001",
    "type": {
      "id": "10000",
      "name": "Blocks",
      "inward": "is blocked by",
      "outward": "blocks"
    },
    "outwardIssue": { "key": "KS-2", "id": "10036" },
    "inwardIssue": null
  }
]
```

Both `inwardIssue` and `outwardIssue` are nullable depending on link direction.

### 5.4 Issue Links — Restore

**Restore endpoint:**

```
POST /rest/api/3/issueLink
```

```json
{
  "type": { "name": "Blocks" },
  "inwardIssue": { "key": "KS-1" },
  "outwardIssue": { "key": "KS-2" }
}
```

**Restore rules:**

- Restore issue links **after** all issues in the basket have been created (end of Stage 3 or a new Stage 3b).
- Use `sourceToTargetIssueKey` map to translate source keys → target keys.
- Skip links where either end issue is NOT in the restore basket and not found at target (non-blocking — log `LINK_SKIPPED_MISSING_ENDPOINT`).
- Link type `name` is used for lookup — Jira resolves by name so no type-ID mapping needed.

**New restore sub-stage: Stage 3b — Issue Links** (after all issues created):

```
Stage 3:  Parent Issues
Stage 3b: Issue Links     ← new, depends on Stage 3 completing
Stage 4:  Comments + Attachments + Boards
Stage 5:  Sprints
Stage 5b: Issue→Sprint associations
```

---

## 6. Restore Identity Design

### 6.1 Label Convention (existing — confirm applied)

On every restored issue, apply label: `original-key:PROJ-123`

This is already implemented in `restoreOrchestrator.js`. Verify it is applied in both CREATE (new issue) and UPDATE (revert-in-place) paths.

### 6.2 Summary Prefix (new)

Prepend `[PROJ-123] ` to the issue summary on restore so the original reference is immediately visible in Jira issue lists without opening the issue:

```
[KS-1] Story 1
```

**Implementation:** In `writeObjectToJira()` issue case, set:

```js
fields.summary = `[${originalKey}] ${fields.summary}`;
```

Where `originalKey` is sourced from `item.key` (the backed-up issue key).

**Idempotency:** On revert-in-place (UPDATE path), strip any existing `[ORIG-KEY]` prefix before prepending, to avoid double-prefixing on repeated restores:

```js
const stripped = fields.summary.replace(/^\[[A-Z]+-\d+\]\s*/, '');
fields.summary = `[${originalKey}] ${stripped}`;
```

### 6.3 Restore Status UI

The restore job result already surfaces failed items with their type and error code. No new UI change is required in this sprint — the label + summary prefix change is the identity mechanism.

---

## 7. Implementation Checklist for Backend Developer

### 7.1 Custom Fields / Issue Fields

- [ ] Add `fields: '*all', expand: 'names'` to `fetchIssuePage` params in `jqlEnumeration.js`
- [ ] Store `issuelinks` array from `issue.raw.fields.issuelinks` in issue snapshot
- [ ] Store `attachment` array with `binaryStorageRef` in issue snapshot

### 7.2 Boards & Sprints Backup

- [ ] Add `enumerateBoards(cloudId, jiraAxios, connectionId)` to `siteObjectEnumeration.js`
  - Paginate `GET /rest/agile/1.0/board` (isLast pattern)
  - Per board: fetch `/board/{id}/configuration`
  - Per scrum board: paginate `GET /rest/agile/1.0/board/{id}/sprint`
- [ ] Store boards as `JiraBoardNode` snapshots in `db.objectSnapshots`
- [ ] Store sprints as `JiraSprintNode` snapshots in `db.objectSnapshots`
- [ ] Update `backupEngine.js` `objectCounts.boards` and `objectCounts.sprints` with real counts
- [ ] Include board/sprint enumeration in `runSiteEnumeration` alongside workflows and custom fields

### 7.3 Boards & Sprints Restore

- [ ] Add board restore case to `writeObjectToJira()` in `restoreOrchestrator.js`
- [ ] Add sprint restore case to `writeObjectToJira()`
- [ ] Build `sourceToBoardId` map (source boardId → target boardId) during Stage 4
- [ ] Build `sourceToSprintId` map during Stage 5
- [ ] Add Stage 5b: issue→sprint association using `POST /rest/agile/1.0/sprint/{id}/issue`

### 7.4 Attachments Restore

- [ ] Implement attachment restore in `writeObjectToJira()` for `nodeType=attachment`
  - Read binary from `binaryStorageRef` (local disk path from `attachmentMaterialisation.js`)
  - POST multipart to `/rest/api/3/issue/{targetKey}/attachments`

### 7.5 Issue Links Restore

- [ ] Add Stage 3b — Issue Links to restore pipeline
- [ ] Implement `restoreIssueLinks(basket, sourceToTargetIssueKey, jiraAxios, cloudId)`:
  - For each issue in basket, read `issuelinks[]`
  - Translate source keys via `sourceToTargetIssueKey`
  - POST `/rest/api/3/issueLink`
  - Skip (non-blocking) if endpoint not found; log `LINK_SKIPPED_MISSING_ENDPOINT`

### 7.6 Restore Identity

- [ ] Apply `[ORIG-KEY]` summary prefix in issue CREATE path in `writeObjectToJira()`
- [ ] Strip existing prefix before prepending in issue UPDATE (revert-in-place) path
- [ ] Confirm `original-key:ORIG-KEY` label is applied in both CREATE and UPDATE paths

---

## 8. API Endpoint Reference Summary

| Object | Backup Endpoint | Restore Endpoint |
|---|---|---|
| Custom Fields | `GET /rest/api/3/field` | `POST /rest/api/3/field` |
| Custom Field Contexts | `GET /rest/api/3/field/{id}/context` | (skip — Jira auto-creates global context) |
| Issues (full fields) | `GET /rest/api/3/search/jql?fields=*all` | `POST /rest/api/3/issue` / `PUT /rest/api/3/issue/{key}` |
| Comments | Inline in issue `fields.comment` | `POST /rest/api/3/issue/{key}/comment` |
| Attachments | `GET /rest/api/3/attachment/content/{id}` | `POST /rest/api/3/issue/{key}/attachments` (multipart) |
| Issue Links | Inline in issue `fields.issuelinks` | `POST /rest/api/3/issueLink` |
| Boards | `GET /rest/agile/1.0/board` + `/board/{id}/configuration` | `POST /rest/agile/1.0/board` |
| Sprints | `GET /rest/agile/1.0/board/{id}/sprint` | `POST /rest/agile/1.0/sprint` |
| Issue→Sprint | Inline in `fields.customfield_10020` | `POST /rest/agile/1.0/sprint/{id}/issue` |
| Workflows | `GET /rest/api/3/workflow/search` | `POST /rest/api/3/workflow/create` |
| Projects | `GET /rest/api/3/project` | `POST /rest/api/3/project` |

---

## 9. Dependency-Ordered Restore Sequence (Updated)

```
Stage 1  — Workflows + CustomFieldDefinitions
Stage 2  — Projects
Stage 3  — Issues (parent-first, then children ordered by parentId)
Stage 3b — Issue Links          [NEW]
Stage 4  — Comments + Attachments + Boards
Stage 5  — Sprints
Stage 5b — Issue→Sprint associations  [NEW]
```

**Inter-stage dependency rules:**

| Stage | Depends On |
|---|---|
| Workflows | — |
| CustomFieldDefinitions | — |
| Projects | Workflows (workflow scheme references) |
| Issues (parent) | Projects |
| Issues (child/subtask) | Parent issues |
| Issue Links | All issues in basket created |
| Comments | Issue created |
| Attachments | Issue created |
| Boards | Project exists at target |
| Sprints | Board exists at target |
| Issue→Sprint | Sprint created, Issue created |

---

## 10. ADRs

### ADR-S22-001: fields=*all in JQL Requests

**Decision:** Add `fields: '*all'` to every JQL search page request.

**Rationale:** Jira's default "navigable" field expansion omits certain custom field types and `issuelinks`. Explicit `*all` guarantees the complete field payload is captured for every issue, including all 56 custom fields.

**Trade-off:** Slightly larger response payload per page. Acceptable — the backup is a periodic batch operation, not real-time.

### ADR-S22-002: Issue Links Restored in a Dedicated Stage 3b

**Decision:** Issue links are restored after all issues are created, not inline with issue creation.

**Rationale:** A link requires both endpoint issues to exist. Creating links inline risks LINK_MISSING_ENDPOINT failures when the linked issue has not yet been written. A dedicated stage after all issues are written eliminates this race.

### ADR-S22-003: Board Restoration Uses Location.ProjectKey, Not filterId

**Decision:** Board restore POSTs with `location.type=project` and `location.projectKeyOrId` rather than restoring the source `filterId`.

**Rationale:** The `filterId` is a source-site artifact and is meaningless on the target site. Jira creates an appropriate board-backing filter automatically when a board is created scoped to a project. The `filterJql` is stored in the snapshot for reference but not used during board creation.

### ADR-S22-004: Summary Prefix [ORIG-KEY] for Restore Identity

**Decision:** Prepend `[ORIG-KEY]` to restored issue summaries in addition to the `original-key:ORIG-KEY` label.

**Rationale:** The label is searchable but not visible in issue list views. The summary prefix makes the original reference immediately visible without opening the issue. Idempotent via strip-before-prepend on update path.
