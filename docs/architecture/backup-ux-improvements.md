# Backup UX Improvements — Design Document

**Author:** Software Architect  
**Date:** 2026-05-01  
**Status:** Accepted — ready for implementation  

---

## 1  Problem Statement

Three UX gaps make the backup workflow opaque and inefficient:

1. **Backup Point ID is invisible.** The trigger confirmation shows only a truncated Job ID. The real identifier needed for Browse and Restore (`backupPointId`, a UUID) is never prominently surfaced to the user and cannot be easily copied.
2. **Backups are buried.** The only way to reach a backup list is via Integrations → connection row → Backups. There is no direct, connection-agnostic entry point from the main navigation.
3. **Browse is disconnected from the backup list.** Opening Browse requires manually entering a Backup Point ID. The browse page has no awareness of which backup point the user came from.

---

## 2  Scope

Three related surfaces must be designed and implemented together:

| Surface | Change |
|---------|--------|
| **S1** — Backup job status card | Show full Backup Point ID + copy-to-clipboard after job completes |
| **S2** — All-Backups global list | New page `/backups-global.html` listing all backup points across all connections, reachable from main nav |
| **S3** — Browse pre-scoping | `browse.html` accepts `?backupPointId=<UUID>` query param; launched from S2 CTA it pre-populates the Object Explorer without manual entry |

---

## 3  Current State Audit

### 3.1  Existing API fields

**POST `/api/connections/:id/backup`** (trigger)  
Response 202: `{ jobId, status, triggeredAt }`  
→ Returns the async *job* ID, not the backup point ID.

**GET `/api/v1/integrations/:id/backup/:jobId`** (poll)  
Response 200: `{ jobId, integrationId, status, phase, triggeredAt, lastHeartbeatAt, completedAt, error, failureReason, backupPointId, objectCounts }`  
→ `backupPointId` is already returned once the job reaches `completed` state.

**GET `/api/v1/integrations/:id/backup-points`** (list by connection)  
Response 200: `{ integrationId, backupPoints: [ { id, createdAt, priorBackupPointId, status, objectCounts } ], total, nextCursor }`  
→ `id` is the Backup Point ID (full UUID).

**GET `/api/v1/backup-points/:backupPointId/issues`** and  
**GET `/api/v1/backup-points/:backupPointId/objects`** (browse/explorer)  
→ Both already accept a full Backup Point ID as path parameter.

### 3.2  Current frontend gaps

| File | Gap |
|------|-----|
| `src/public/backups.html` | Truncates backup point ID to `id.split('-')[0]`; no copy action. Requires `?connectionId=...` — cannot be reached without one. |
| `src/public/index.html` | "Backups" nav card points to `connections.html` (not a backups page). |
| `src/public/browse.html` | No URL-param handling for `backupPointId`; user must type the ID manually. |
| Top navigation | Has no "Backups" link. |

---

## 4  Required Backend Changes

### 4.1  New global backup-points list endpoint

A single new endpoint is needed for Surface 2 (global list across all connections):

```
GET /api/v1/backup-points
```

**Query parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 20 | Max rows per page (max 100) |
| `cursor` | string | — | Pagination cursor (last seen `id`) |
| `connectionId` | string | — | Filter to a single connection (optional) |

**Response 200:**
```json
{
  "backupPoints": [
    {
      "id": "<UUID>",
      "integrationId": "<UUID>",
      "siteName": "mysite.atlassian.net",
      "createdAt": "2026-05-01T14:30:00.000Z",
      "status": "completed",
      "objectCounts": {
        "issues": 128,
        "projects": 2,
        "workflows": 4,
        "customFields": 12,
        "boards": 1,
        "sprints": 3,
        "attachments": 7
      }
    }
  ],
  "total": 14,
  "nextCursor": "<UUID or null>"
}
```

**Notes:**
- Sorted by `createdAt` DESC (newest first).
- `siteName` is resolved from the connection record (`connection.siteName || connection.siteUrl || integrationId`) — this avoids a second round-trip from the frontend.
- Backup points from soft-deleted or hard-deleted connections are still returned (they represent historical data); a `connectionStatus` field may be included for rendering a visual indicator.
- No authentication changes required — this is an internal API.

**Implementation location:** New handler block in `src/routes/backup.js` (or a small new `src/routes/backupPointsGlobal.js` registered in `app.js`).

### 4.2  No changes to existing endpoints

The poll endpoint (`GET /api/v1/integrations/:id/backup/:jobId`) already returns `backupPointId` — no backend change is needed for Surface 1.

The browse endpoints already accept `backupPointId` by path — no backend change is needed for Surface 3.

---

## 5  Surface 1 — Backup Job Status Card

### 5.1  Trigger response (202)

The trigger response already returns `{ jobId }`. The UI should display this as a transient "job in progress" identifier only — not as the canonical backup ID.

### 5.2  Job summary card on completion

After the job status poll returns `status: "completed"`, the `backupPointId` field is present in the job response. The `showJobSummaryCard()` function in `backups.html` must be updated to:

1. **Display the full Backup Point ID** in a monospace block labelled "Backup Point ID":
   ```
   Backup Point ID
   [  f3a82c10-91bb-4d01-8b5c-2dc6e4c93001  ] [Copy]
   ```
2. **Copy-to-clipboard button** uses `navigator.clipboard.writeText(backupPointId)`. On success, the button label changes to "Copied!" for 2 seconds then resets. No external library required.
3. **Browse CTA**: After copying, or directly via a second CTA, show a button "Browse this backup" that navigates to `/browse.html?backupPointId=<UUID>`.

### 5.3  Copy-to-clipboard interaction spec

```
[ f3a82c10-91bb-4d01-8b5c-2dc6e4c93001 ]  [ 📋 Copy ID ]
```

- Input is `readonly`, selectable, monospace.
- Button label: `Copy ID` → `Copied!` (2 s) → `Copy ID`.
- If `navigator.clipboard` is unavailable (non-HTTPS in very old browsers), fall back to `document.execCommand('copy')` on a selected input.
- On error, show a small inline tooltip: "Copy failed — select manually".

### 5.4  Component data contract (job summary card)

The card renderer receives:
```js
{
  jobId: string,           // async job UUID — shown secondary only
  backupPointId: string,   // canonical backup UUID — shown prominently
  status: "completed" | "failed" | "auth_error",
  completedAt: string,     // ISO timestamp
  objectCounts: object | null,
  error: string | null,
}
```

---

## 6  Surface 2 — All-Backups Global List

### 6.1  New page: `/backups-global.html`

A standalone HTML page, no `connectionId` URL parameter required.

**Top navigation:** Add a `Backups` link between `Integrations` and `Browse` in the `topnav-links` bar across all pages.

**Home page card:** Change the "Backups" nav card `href` from `connections.html` to `/backups-global.html`.

### 6.2  Page layout

```
[Jira Workload]  Integrations  Backups*  Browse  Resilience  SDI
──────────────────────────────────────────────────────────────────
All Backup Points
─────────────────────────────────────────────────────────────────
[🔍 Filter by connection ▾]                          [Refresh]

┌────────────────────────────────────────────────────────────────┐
│ Backup Point ID          │ Connection │ Taken at   │ Status │ Contents  │ Actions │
│──────────────────────────│────────────│────────────│────────│───────────│─────────│
│ f3a82c10-… [Copy]        │ mysite.… │ 1 May 6:30 │ ●done  │ 128 iss.  │[Browse] │
│ aabb9910-… [Copy]        │ devsite.… │ 1 May 3:00 │ ●done  │  42 iss.  │[Browse] │
└────────────────────────────────────────────────────────────────┘
  Showing 20 of 31 total                            [Load more]
```

### 6.3  Column contract

| Column | Source field | Notes |
|--------|-------------|-------|
| **Backup Point ID** | `backupPoint.id` | Truncated display (`id.slice(0,8)…`) + copy button; full UUID visible on hover/title attribute |
| **Connection** | `backupPoint.siteName` | From the global endpoint; links to `/backups.html?connectionId=<integrationId>` |
| **Taken at** | `backupPoint.createdAt` | Formatted as locale date + time |
| **Status** | `backupPoint.status` | Badge: `completed` (green) / `running` (amber) / `failed` (red) |
| **Contents** | `backupPoint.objectCounts` | Compact: `128 issues · 2 projects · 4 workflows` |
| **Actions** | — | `Browse` button → `/browse.html?backupPointId=<UUID>` |

### 6.4  Pagination

- Default page size: 20.
- "Load more" appends next page results (cursor-based); no full reload.
- Filter by connection: client-side dropdown filtering of loaded results (or re-fetch with `connectionId` query param if list is large).

### 6.5  Empty state

```
💾  No backup points yet
Trigger your first backup from an Integration.
[→ Go to Integrations]
```

---

## 7  Surface 3 — Browse Pre-Scoping

### 7.1  URL parameter

`browse.html` must read the query string on `DOMContentLoaded`:

```
/browse.html?backupPointId=f3a82c10-91bb-4d01-8b5c-2dc6e4c93001
```

When `backupPointId` is present in the URL:

1. **Activate the Object Explorer tab** (or whichever tab is the primary explore surface) immediately instead of landing on the global-search tab.
2. **Pre-populate the Backup Point ID input** field (if one exists) with the value from the URL. The user should not need to type it.
3. **Auto-trigger the initial object load** (`nodeType=JiraProjectNode` or the default node type) using the supplied `backupPointId` so results are shown immediately without additional user action.
4. Show a **contextual breadcrumb / header** that displays:  
   ```
   ← Back to Backups    Backup Point: f3a82c10…  [Copy ID]
   ```

### 7.2  Back-navigation

When launched with `backupPointId`, the "← Back to Backups" link should navigate to `/backups-global.html` (not to a specific connection page, since the user may not know the connectionId at this point). The global list preserves their position via scroll state or they can re-filter.

### 7.3  Existing browse page contract

The Object Explorer already calls:
```
GET /api/v1/backup-points/:backupPointId/objects?nodeType=...
```
No API changes are needed — the `backupPointId` is passed directly as a path parameter.

### 7.4  No auto-search in other tabs

The Issue Search, Attachment Search, Board/Sprint Search tabs also accept a `backupPointId` as a filter. When the URL param is present, those tabs should **not** auto-search — only the Object Explorer tab auto-loads. The other tabs may silently pre-fill the backup point ID field so the user doesn't have to re-enter it if they switch tabs manually.

---

## 8  Navigation Changes Summary

| Location | Current | Change |
|----------|---------|--------|
| Top nav (all pages) | No "Backups" link | Add `<a href="/backups-global.html">Backups</a>` after "Integrations" |
| Home page nav-card "Backups" | Links to `connections.html` | Change `href` to `/backups-global.html` |
| `backups.html` header | "← All Integrations" back link | Keep; add secondary "← All Backups" link pointing to `/backups-global.html` |
| `browse.html` header | No back link | When `?backupPointId=...` is in URL, show "← Back to Backups" → `/backups-global.html` |

---

## 9  API Route Plan

| Method | Path | New/Existing | Purpose |
|--------|------|-------------|---------|
| `GET` | `/api/v1/backup-points` | **NEW** | Global list of all backup points (S2) |
| `GET` | `/api/v1/integrations/:id/backup/:jobId` | Existing | Job poll — already returns `backupPointId` (S1) |
| `GET` | `/api/v1/integrations/:id/backup-points` | Existing | Per-connection list (unchanged) |
| `GET` | `/api/v1/backup-points/:id/objects` | Existing | Object Explorer (S3) |
| `GET` | `/api/v1/backup-points/:id/issues` | Existing | Issue search (S3) |

The new `GET /api/v1/backup-points` endpoint should be registered in `src/app.js` mounted at `/api/v1`.

---

## 10  Implementation Order

To avoid half-baked states, the implementation should proceed in this order:

1. **Backend first:** Implement `GET /api/v1/backup-points` (global endpoint).
2. **S2 (global list page):** Build `backups-global.html` + wire up the global endpoint + add nav links.
3. **S1 (job summary card):** Update `showJobSummaryCard()` in `backups.html` to display full `backupPointId` with copy-to-clipboard and Browse CTA.
4. **S3 (browse pre-scoping):** Add URL-param handling to `browse.html`.
5. **Navigation wiring:** Update `topnav-links` on all pages and home nav-card.

Each step is independently testable and does not break existing functionality.

---

## 11  ADRs

### ADR-BUX-001: New global endpoint over client-side aggregation

**Decision:** Add a backend `GET /api/v1/backup-points` endpoint rather than having the frontend iterate `GET /api/v1/integrations` then `GET .../backup-points` for each connection.

**Rationale:** N+1 requests from the client for a list page is slow and brittle. The backend can join connection metadata (siteName) efficiently in a single response. Pagination is also cleaner server-side.

### ADR-BUX-002: Backup Point ID displayed prominently — Job ID demoted

**Decision:** On job completion, the Backup Point ID (the persistent, reusable UUID) is shown as the primary identifier. The Job ID is shown only secondarily in smaller text.

**Rationale:** The Job ID is transient and has no use after the job completes. The Backup Point ID is what the user needs for Browse and Restore. Displaying the wrong ID as primary causes the confusion the user reported.

### ADR-BUX-003: Browse pre-scoping via URL param — no server-side session

**Decision:** Pre-scoping of browse is achieved via `?backupPointId=UUID` URL parameter only — no server-side session or cookie.

**Rationale:** Stateless URL routing is bookmarkable, shareable, and consistent with the existing pattern used by `backups.html?connectionId=...`. No new infrastructure required.

### ADR-BUX-004: `backups-global.html` as a new page — not replacing `backups.html`

**Decision:** Create a new `/backups-global.html` page rather than making `backups.html` work without a connectionId.

**Rationale:** `backups.html` is the per-connection detail view (trigger backup, restore, progress panel). It serves a different purpose from a global list. Conflating them in a single page would add complexity and risk regressions in existing trigger/restore flows. The two pages are complementary.
