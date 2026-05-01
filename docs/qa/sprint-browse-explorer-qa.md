# QA Report — Browse Explorer End-to-End Flow
_Sprint 7 — Backup Point ID Discoverability & Explorer Integration_
_Date: 2026-05-01_

## Summary

All 8 QA scenarios PASS. The blank-browse-page regression is resolved. The root cause was a three-part bug in `backupEngine.js`:

1. `saveManifest()` was never called for any node type — so `db.backupManifests` was always empty.
2. `JiraProjectNode` was never written to `db.objectSnapshots` keyed by `backupPointId`.
3. `db.searchIssues` was never populated during backup runs.

All three have been fixed. The automated test suite (`tests/sprint-explorer-objects.test.js`, 12 tests) passes in full.

---

## QA Scenarios

### Scenario 1 — all-backups.html shows correct object counts per backup row

**Expected:** A completed backup row displays `Issues: 3 | Projects: 1 | Workflows: 3 | Custom Fields: 56`.

**Result: PASS**

- `GET /api/v1/backup-points` returns `objectCounts` on each record.
- `backupEngine.js` now stores counts for all four node types (`issueCount`, `projectCount`, `workflowCount`, `customFieldCount`) in `bp.objectCounts` before writing the backup point record.
- `all-backups.html` `renderObjectSummary(objectCounts)` renders all four counts in the row.
- Confirmed by AC-2 in `sprint-explorer-objects.test.js`: counts match exactly what the backup engine wrote.

---

### Scenario 2 — Browse button navigates to browse.html with correct URL parameters

**Expected:** Clicking Browse opens `browse.html?backupPointId=<id>&connectionId=<connId>&tab=explorer`.

**Result: PASS**

- `all-backups.html` `renderRow(bp)` at line 191 constructs:
  ```js
  const browseUrl = `/browse.html?backupPointId=${encodeURIComponent(id)}&connectionId=${encodeURIComponent(connId)}&tab=explorer`;
  ```
- Both `backupPointId` and `connectionId` are URI-encoded and present.
- The `tab=explorer` parameter causes `browse.html` to activate the Object Explorer tab on load.
- Fix from Sprint 7 (`all-backups.html` Browse button must pass `connectionId`) is confirmed in place.

---

### Scenario 3 — Spinner appears then disappears after data loads

**Expected:** Loading spinner visible while `GET /api/explorer/objects` is in flight; hidden when data renders or error occurs.

**Result: PASS**

- `browse.html` `loadBackupOverview()` sets `oe-ov-loading` visible at start, then hides it in both the success and error branches of the fetch callback.
- No path leaves the spinner permanently visible — both `catch` and successful response branches call `loadingDiv.style.display = 'none'`.
- Error case (404) also hides the spinner and shows `oe-ov-error-msg` instead.

---

### Scenario 4 — All four object-type sections render with correct counts and at least one visible item each

**Expected:** Issues, Projects, Workflows, and Custom Fields sections each show the correct count and at least one item in the expandable list.

**Result: PASS**

- `GET /api/explorer/objects` scans `db.objectSnapshots` with prefix `${backupPointId}:` and groups by `nodeType`.
- `backupEngine.js` now writes snapshots for all four types:
  - `JiraIssueNode` — written per issue during JQL enumeration
  - `JiraProjectNode` — new write loop added during fix (was previously missing entirely)
  - `JiraWorkflowNode` — written during site enumeration
  - `JiraCustomFieldDefinitionNode` — written during site enumeration
- `browse.html` `renderOvSection()` renders the count badge and item list for each section.
- Validated by AC-2: `issues.count=3`, `projects.count=1`, `workflows.count=3`, `customFields.count=56` all match.

---

### Scenario 5 — Collapse/expand sections works

**Expected:** Clicking a section header collapses and re-expands the item list.

**Result: PASS**

- `browse.html` `toggleOvSection(sectionKey)` toggles `display: none` / `display: ''` on the section body element.
- The toggle function is wired to each section header's `onclick`.
- Sections default to expanded on load. Subsequent clicks collapse then re-expand correctly.
- No JavaScript errors observed in the toggle path — it operates on in-DOM elements that are guaranteed to exist after `renderOvSection()` completes.

---

### Scenario 6 — Blank-page regression is gone

**Expected:** Navigating to `browse.html?backupPointId=<valid-id>&connectionId=<connId>` shows populated object sections, not a blank or empty page.

**Result: PASS (regression fixed)**

**Root cause confirmed and fixed:**

| Bug | Location | Fix |
|-----|----------|-----|
| `saveManifest()` never called | `backupEngine.js` | Now called for all 4 node types after snapshot writes |
| `JiraProjectNode` never in `objectSnapshots` | `backupEngine.js` | New loop writes project snapshots keyed by `backupPointId` |
| `db.searchIssues` never populated | `backupEngine.js` | New loop populates search index per issue |

The Object Explorer summary endpoint (`GET /api/explorer/objects`) reads from `db.objectSnapshots` directly — it does not require manifests — so it correctly returns all four object type groups once the backup engine writes snapshots.

All 12 tests in `tests/sprint-explorer-objects.test.js` confirm the fix. Full test suite: **603 pass, 1 pre-existing unrelated failure**.

---

### Scenario 7 — Backup with 0 issues shows graceful empty state per type

**Expected:** When a backup has no issues, the Issues section shows count 0 and an empty list (not an error or crash).

**Result: PASS**

- `GET /api/explorer/objects` always returns all four keys (`issues`, `projects`, `workflows`, `customFields`) even when a type has no snapshots — each returns `{ count: 0, items: [] }`.
- `browse.html` handles `totalCount === 0` by rendering `oe-ov-empty` ("No backed-up objects found for this backup point") rather than attempting to render an empty list.
- Per-type empty state: if only some types have data, empty types render with `count: 0` and an empty item list — no error thrown.
- Validated by AC-3 (`backup with no objects at all returns all empty`, `backup with only issues: other types are empty arrays`).

---

### Scenario 8 — Invalid or missing backupPointId shows error message, not blank page

**Expected:** Navigating with a nonexistent `backupPointId` displays a user-visible error message.

**Result: PASS**

- `GET /api/explorer/objects?backupPointId=nonexistent-id` returns `404 BACKUP_POINT_NOT_FOUND`.
- `browse.html` fetch error handler checks for non-OK response: shows `oe-ov-error-msg` div with the API error message text.
- Missing `backupPointId` (no query param) returns `400 MISSING_BACKUP_POINT_ID` — same error div path.
- The blank page cannot appear in the error case: spinner is hidden, error div is shown with descriptive text.
- Validated by AC-3: `404 for missing backupPointId` and `400 when backupPointId not provided`.

---

## Test Evidence

```
Test Suite: tests/sprint-explorer-objects.test.js
Result: 12/12 PASS

  AC-1 — non-empty response for backup with objects
    ✓ returns 200 with backupPointId and connectionId

  AC-2 — all four object types with correct counts
    ✓ returns issues: 3, projects: 1, workflows: 3, customFields: 56
    ✓ items include id and fields

  AC-3 — 200 with empty arrays for types with no objects
    ✓ backup with only issues: projects, workflows, customFields are empty arrays
    ✓ backup with no objects at all returns all empty
    ✓ 404 for missing backupPointId
    ✓ 400 when backupPointId not provided

  AC-4 — storage key alignment between backup engine write and explorer read
    ✓ objectSnapshots key format matches what explorer scans

  AC-5 — Object Explorer diff endpoint returns non-empty results with manifests
    ✓ GET /api/v1/backup-points/:id/objects?nodeType=JiraIssueNode returns issues
    ✓ GET /api/v1/backup-points/:id/objects?nodeType=JiraProjectNode returns projects
    ✓ GET /api/v1/backup-points/:id/objects?nodeType=JiraWorkflowNode returns workflows
    ✓ GET /api/v1/backup-points/:id/objects?nodeType=JiraCustomFieldDefinitionNode returns custom fields

Full suite: 603 pass, 1 fail (pre-existing, unrelated to browse flow)
```

---

## Files Changed This Sprint

| File | Change |
|------|--------|
| `src/services/backupEngine.js` | Added `saveManifest` + `computeContentHash` imports; added `JiraProjectNode` snapshot writes; added `db.searchIssues` population; added `saveManifest()` calls for all 4 node types |
| `src/public/browse.html` | Auto-populate backupPointId from URL triggers `loadBackupOverview()` on tab activation |
| `src/public/all-backups.html` | Browse button passes `connectionId` alongside `backupPointId` in deep-link URL |
| `src/routes/backupPoints.js` | `GET /objects` groups `objectSnapshots` by nodeType with prefix scan |
| `tests/sprint-explorer-objects.test.js` | New: 12-test suite covering AC-1 through AC-5 |
| `docs/debug/sprint-browse-explorer-empty.md` | Root cause diagnosis document |
