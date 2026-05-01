# Diagnosis: Object Explorer Returns Empty Despite Backed-Up Objects

**Date:** 2026-05-01  
**Symptom:** Backup shows Issues: 3, Projects: 1, Workflows: 3, Custom Fields: 56 in the All Backups list. Clicking Browse → Object Explorer tab shows "No objects found" regardless of node type chosen.

---

## Summary

The backup engine writes `objectSnapshots` (the per-object field data) but **never calls `saveManifest()`**, so `db.backupManifests` is always empty. The Object Explorer reads manifests first to build its object list; finding no manifest entries, it returns zero results even though all the snapshot data is sitting in the database.

Additionally, `JiraProjectNode` snapshots are never written to `objectSnapshots` at all, meaning even if the manifest problem were fixed the default "Project" node type view would still be empty.

---

## Full Data Pipeline Trace

### 1. URL construction — `all-backups.html:191`

```js
const browseUrl = `/browse.html?backupPointId=${encodeURIComponent(id)}&connectionId=${encodeURIComponent(connId)}&tab=explorer`;
```

**Both `backupPointId` and `connectionId` are correctly passed.** This part is fine.

---

### 2. Frontend bootstrap — `browse.html:1408–1456`

On `DOMContentLoaded`:
- Reads `backupPointId` from URL, writes it into `#oe-backup-id` (line 1421).
- Defaults `nodeType` to `JiraProjectNode` if none specified in URL (line 1452).
- Calls `searchObjects()` immediately (line 1455).

**This part is fine.**

---

### 3. API call fired — `browse.html:1343`

```
GET /api/v1/backup-points/{backupPointId}/objects?nodeType=JiraProjectNode&changeIndicator=Added,Modified,Deleted&limit=50
```

**The correct endpoint is called with the correct backupPointId.** This part is fine.

---

### 4. Backend route — `backupPoints.js:239–295`

- Validates `backupPointId` exists in `db.backupPoints` — succeeds (record was written by backup engine).
- Validates `nodeType` — succeeds (`JiraProjectNode` is in `VALID_NODE_TYPES`).
- Calls `runObjectExplorerDiff(backupPointId, 'JiraProjectNode', [...], undefined, 50, undefined)`.

**This part is fine.**

---

### 5. Object Explorer diff engine — `objectExplorerService.js:199–289`

```js
const currentManifest = getManifest(backupPointId, nodeType);   // line 210
const currentEntries = currentManifest ? currentManifest.entries : [];  // line 213
```

`getManifest(backupPointId, 'JiraProjectNode')` does:
```js
return db.backupManifests.get(`${backupPointId}:JiraProjectNode`) || null;
```

**`db.backupManifests` has no entry for this key → returns `null` → `currentEntries = []`.**

```js
const changeMap = computeChangeMap([], []);  // line 217
// changeMap is empty — nothing to iterate
```

Result: `allItems = []`, returns `{ results: [], total: 0 }`.

---

### 6. Frontend rendering — `browse.html:1347`

```js
const results = data.results || [];      // = []
if (!results.length) { panelEmpty('oe'); return; }   // fires immediately
```

Displays: "No objects found. Enter a backup point ID and node type, then click Explore."

---

## Root Cause: `backupEngine.js` Never Calls `saveManifest()`

**Primary bug location:** `src/services/backupEngine.js` lines 211–243 (the object persistence block).

### What the backup engine DOES write

| Store | Key pattern | Written for |
|---|---|---|
| `db.objectSnapshots` | `${backupPointId}:JiraIssueNode:${issueId}` | Every issue (line 215) |
| `db.objectSnapshots` | `${backupPointId}:JiraWorkflowNode:${wfId}` | Every workflow (line 226) |
| `db.objectSnapshots` | `${backupPointId}:JiraCustomFieldDefinitionNode:${field.id}` | Every custom field (line 234) |
| `db.backupPoints` | `${backupPointId}` | Backup point metadata (line 209) |

### What the backup engine NEVER writes

| Store | Key pattern | Impact |
|---|---|---|
| `db.backupManifests` | `${backupPointId}:JiraIssueNode` | Object Explorer shows 0 issues |
| `db.backupManifests` | `${backupPointId}:JiraWorkflowNode` | Object Explorer shows 0 workflows |
| `db.backupManifests` | `${backupPointId}:JiraCustomFieldDefinitionNode` | Object Explorer shows 0 custom fields |
| `db.backupManifests` | `${backupPointId}:JiraProjectNode` | Object Explorer shows 0 projects |
| `db.objectSnapshots` | `${backupPointId}:JiraProjectNode:${id}` | **Project snapshots never stored** |

### Why `saveManifest()` exists but is never called

`objectExplorerService.js` exports `saveManifest()` (line 110–118) for exactly this purpose. It was written to be called from the backup engine, but the backup engine never imports or calls it.

---

## Secondary Bug: `JiraProjectNode` Not in `objectSnapshots` at All

When browse.html deep-links from all-backups.html, it defaults to `nodeType=JiraProjectNode` (line 1452). Even if manifests were fixed for other node types, the project view would still return empty because:

1. **No `objectSnapshots` entries for `JiraProjectNode`** — `backupEngine.js` writes project metadata to `db.projectNodes` (keyed `${integrationId}:${projectKey}`) but never to `db.objectSnapshots` under a `backupPointId`.
2. **No manifest for `JiraProjectNode`** — follows from the primary bug.

When `runObjectExplorerDiff` tries to load fields for a project object (line 238):
```js
const currentSnapshot = db.objectSnapshots.get(`${backupPointId}:JiraProjectNode:${id}`);
fields = currentSnapshot ? currentSnapshot.fields : {};
```
It would get `{}` (empty fields) even if a manifest entry existed.

---

## Tertiary Bug: `db.searchIssues` Never Populated (affects Issue Search tab)

The Issue Search tab queries `db.searchIssues` (backupPoints.js line 146), but the backup engine never writes to this collection. This is a separate issue from the Object Explorer bug but has the same root pattern — the collection is declared and read, but never populated.

---

## Fix Approach

### Backend change: `src/services/backupEngine.js`

**Where:** In `runIntegrationBackup()`, after the existing `objectSnapshots` block (after line 240, before the `saveDb()` call on line 244).

**What to add:** Call `saveManifest()` (imported from `./objectExplorerService`) for every node type that has objects, supplying `{ id, contentHash }` entries. Also add `JiraProjectNode` to both `objectSnapshots` and the manifest.

```js
const { computeContentHash, saveManifest } = require('./objectExplorerService');

// --- After the existing objectSnapshots block ---

// JiraProjectNode: write snapshots AND manifest (currently missing entirely)
const projectManifestEntries = [];
for (const pr of projectResults) {
  const projNode = db.projectNodes.get(`${integrationId}:${pr.projectKey}`);
  if (projNode) {
    const projId = projNode.id || pr.projectKey;
    db.objectSnapshots.set(`${backupPointId}:JiraProjectNode:${projId}`, {
      backupPointId,
      nodeType: 'JiraProjectNode',
      id: projId,
      fields: projNode,
    });
    projectManifestEntries.push({ id: projId, contentHash: computeContentHash(projNode) });
  }
}
saveManifest(backupPointId, 'JiraProjectNode', projectManifestEntries);

// JiraIssueNode: manifest was missing; snapshots already written
const issueManifestEntries = [];
for (const pr of projectResults) {
  for (const issue of pr.issues || []) {
    const issueId = issue.id || issue.key;
    issueManifestEntries.push({ id: issueId, contentHash: computeContentHash(issue.fields || {}) });
  }
}
saveManifest(backupPointId, 'JiraIssueNode', issueManifestEntries);

// JiraWorkflowNode: manifest was missing; snapshots already written
const wfManifestEntries = (siteEnumResult.workflows || []).map(wf => ({
  id: wf.id || wf.name,
  contentHash: computeContentHash(wf),
}));
saveManifest(backupPointId, 'JiraWorkflowNode', wfManifestEntries);

// JiraCustomFieldDefinitionNode: manifest was missing; snapshots already written
const fieldManifestEntries = (siteEnumResult.fields || []).map(field => ({
  id: field.id,
  contentHash: computeContentHash(field),
}));
saveManifest(backupPointId, 'JiraCustomFieldDefinitionNode', fieldManifestEntries);
```

### No frontend change required

The frontend correctly passes `backupPointId`, fires the right API call, and renders whatever results it receives. Once the backend starts returning non-empty results, the explorer will display them without any frontend changes.

---

## Fix for `db.searchIssues` (Issue Search tab — separate task)

In `jqlEnumeration.js` (or at the end of `runIntegrationBackup`), for each backed-up issue, write a record to `db.searchIssues` keyed by `${backupPointId}:${issueId}`:

```js
db.searchIssues.set(`${backupPointId}:${issueId}`, {
  id: issueId,
  backupPointId,
  key: issue.key,
  summary: issue.fields?.summary,
  issuetype: issue.fields?.issuetype?.name,
  status: issue.fields?.status?.name,
  statusCategory: issue.fields?.status?.statusCategory?.name,
  priority: issue.fields?.priority?.name,
  assignee: issue.fields?.assignee || null,
  reporter: issue.fields?.reporter || null,
  labels: issue.fields?.labels || [],
  created: issue.fields?.created,
  updated: issue.fields?.updated,
  resolved: issue.fields?.resolutiondate || null,
  projectKey: issue.fields?.project?.key,
});
```

---

## Summary Table

| Bug | Location | Symptom | Fix |
|---|---|---|---|
| `saveManifest()` never called | `backupEngine.js:211–243` | Object Explorer returns 0 results for all node types | Call `saveManifest()` for each node type after snapshot write |
| `JiraProjectNode` never in `objectSnapshots` | `backupEngine.js:211–243` | Project Explorer empty even with fixed manifests | Write project snapshots to `objectSnapshots` and manifest |
| `db.searchIssues` never populated | `backupEngine.js` or `jqlEnumeration.js` | Issue Search tab always returns 0 results | Write to `db.searchIssues` during backup |
