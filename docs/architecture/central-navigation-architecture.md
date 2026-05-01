# Central Navigation and Integration Management Architecture

**Sprint 12 — Architecture Document**
**Author:** Software Architect
**Date:** 2026-05-01
**Status:** Approved — Ready for Implementation

---

## 1. Problem Statement

The current application has six functional pages that are not connected by any navigation layer. Users must know URLs in advance, and the entry point (`/`) redirects to the OAuth wizard rather than a home dashboard. Critical flows are broken or missing:

| Problem | Root Cause |
|---|---|
| Cannot trigger a backup from the UI | `manage.html` has no "Back Up Now" button; `POST /api/v1/integrations/:id/backup` exists but is not surfaced |
| Cannot list or switch between multiple connections | No `GET /api/v1/integrations` endpoint; `manage.html` requires a `connectionId` URL param supplied manually |
| No central landing page | `/` redirects to the connect wizard, not a dashboard |
| No global navigation | Each page is an island — users rely on browser history |
| Data lost on restart | All storage is in-memory (`Map` objects in `src/db/index.js`) |
| No backup history in the UI | `GET /api/v1/integrations/:id/backup-points` is missing |

---

## 2. New Page Structure

### 2.1 Route Map (complete, including existing pages)

| URL | File | Purpose | Status |
|---|---|---|---|
| `/` | — | Redirects to `/index.html` | **Changed** (was `/connect.html`) |
| `/index.html` | `src/public/index.html` | Dashboard — navigation hub, connection status summary | **New** |
| `/connections.html` | `src/public/connections.html` | Multi-connection list, add/manage/delete | **New** |
| `/backups.html` | `src/public/backups.html` | Per-integration backup list, trigger, restore entry | **New** |
| `/connect.html` | `src/public/connect.html` | OAuth connection wizard | Existing |
| `/callback.html` | `src/public/callback.html` | OAuth callback result + scope validation | Existing |
| `/manage.html?connectionId=<id>` | `src/public/manage.html` | Single integration settings (project scope, lifecycle) | **Extended** |
| `/browse.html` | `src/public/browse.html` | Browse/search backed-up data | Existing |
| `/sdi.html` | `src/public/sdi.html` | SDI findings dashboard | Existing |
| `/resilience.html` | `src/public/resilience.html` | Resilience Module — protected object inventory | Existing |

### 2.2 Page Descriptions

#### `/index.html` — Dashboard (new)
Central landing page. Shown after login/startup.

- **Summary cards:** Total connections, active connections, last backup time, next scheduled backup.
- **Connection status list:** Short table of all connections (site name, status badge, last synced). Fetched from `GET /api/v1/integrations`.
- **Quick actions:** "Add Connection" → `/connect.html`; "View All Connections" → `/connections.html`; "View Backups" → `/backups.html`.
- **Navigation bar** (shared across all pages): Dashboard | Connections | Backups | Browse | SDI | Resilience.

#### `/connections.html` — Connections Management (new)
Full multi-connection CRUD page.

- Lists all connections via `GET /api/v1/integrations`.
- Per-row actions: **Manage Settings** (`/manage.html?connectionId=X`), **Back Up Now** (`POST /api/v1/integrations/:id/backup`), **View Backups** (`/backups.html?connectionId=X`), **Delete** (soft-delete modal).
- "Add New Connection" button → `/connect.html`.
- Status badges: Active, Degraded, Expiring Soon, Expired, Deleted.
- Token health inline indicators (calls `GET /api/v1/integrations/:id/token-health` lazily per row).

#### `/backups.html` — Backup Management (new)
Backup history and trigger per integration.

- Connection selector dropdown (populated from `GET /api/v1/integrations`); pre-selects if `?connectionId=X` in URL.
- **"Back Up Now"** button → calls `POST /api/v1/integrations/:id/backup`.
- Backup history table (calls `GET /api/v1/integrations/:id/backup-points`):
  - Columns: Timestamp, Status, Issues, Workflows, Custom Fields, Attachments, Actions.
  - Per-row actions: **Browse** (`/browse.html?backupPointId=X`), **Restore** (entry to restore wizard), **SDI Scan** (`/sdi.html?backupPointId=X`).
- Progress indicator when backup is running (polls `GET /api/v1/integrations/:id/backup/run-states`).

#### `/manage.html` — Single Integration Settings (extended)
Adds a "Back Up Now" section at the top and a link to the backup history.

- New **Backup** section above project scope: displays last backup time + "Back Up Now" button.
- "View Backup History" link → `/backups.html?connectionId=<id>`.
- Back link → `/connections.html`.

#### Shared Navigation Bar (all pages)
A top navigation bar embedded in every HTML page (no JS framework — plain HTML/CSS):

```
[Dashboard]  [Connections]  [Backups]  [Browse]  [SDI]  [Resilience]
```

Active page highlighted. No server-side session required; `window.location.pathname` used to detect active route.

---

## 3. API Gap Analysis

### 3.1 Missing Endpoints (must be implemented)

#### `GET /api/v1/integrations` — List All Connections

**Purpose:** Needed by `/index.html`, `/connections.html`, `/backups.html` (connection selector).

**Route file:** `src/routes/integrations.js`

**Request:** `GET /api/v1/integrations?status=active` (optional filter; default: all non-hard-deleted)

**Response:**
```json
{
  "connections": [
    {
      "connectionId": "uuid",
      "siteName": "mysite.atlassian.net",
      "siteUrl": "https://mysite.atlassian.net",
      "status": "active",
      "boardScopeDegraded": false,
      "connectedAt": "2026-05-01T10:00:00.000Z",
      "lastSyncedAt": "2026-05-01T12:00:00.000Z",
      "connectionPath": "express"
    }
  ],
  "total": 1
}
```

**Error codes:** none (returns empty array if no connections exist).

**Notes:**
- Excludes `hard_deleted` connections by default.
- `status` query param accepts: `active`, `degraded`, `expired`, `soft_deleted`, or `all`.

---

#### `GET /api/v1/integrations/:id/backup-points` — List Backup Points

**Purpose:** Needed by `/backups.html` to show backup history.

**Route file:** `src/routes/backup.js`

**Request:** `GET /api/v1/integrations/:id/backup-points?limit=20&cursor=<opaque>`

**Response:**
```json
{
  "integrationId": "uuid",
  "backupPoints": [
    {
      "id": "bp-uuid",
      "createdAt": "2026-05-01T12:00:00.000Z",
      "priorBackupPointId": "bp-prev-uuid",
      "status": "completed",
      "objectCounts": {
        "issues": 124,
        "workflows": 3,
        "customFieldDefinitions": 12,
        "attachments": 8
      }
    }
  ],
  "total": 1,
  "nextCursor": null
}
```

**Error codes:**
- `404 CONNECTION_NOT_FOUND` — integration ID does not exist.

**Notes:**
- Results sorted by `createdAt DESC`.
- `objectCounts` fields default to `0` if not yet populated; implementation may initially return zeros until backup engine populates this metadata.

---

### 3.2 Existing Endpoints (used by new pages — no change required)

| Endpoint | Used by | Notes |
|---|---|---|
| `POST /api/v1/integrations/:id/backup` | `/connections.html`, `/manage.html`, `/backups.html` | Already implemented |
| `GET /api/v1/integrations/:id` | `/manage.html` | Already implemented |
| `GET /api/v1/integrations/:id/token-health` | `/connections.html`, `/manage.html` | Already implemented |
| `DELETE /api/v1/integrations/:id` | `/connections.html`, `/manage.html` | Already implemented |
| `POST /api/v1/integrations/:id/restore` | `/connections.html` (restore soft-deleted) | Already implemented |
| `PATCH /api/v1/integrations/:id/project-scope` | `/manage.html` | Already implemented |
| `GET /api/v1/integrations/:id/backup/run-states` | `/backups.html` (progress polling) | Already implemented |

---

## 4. Multi-Connection Data Model

### 4.1 Primary Key

`connectionId` (UUID v4) is the canonical primary key for every connection record. It is:
- Generated at OAuth callback time and stored in `db.connections`.
- Passed as a URL query parameter to connection-scoped pages (`?connectionId=<uuid>`).
- Never auto-incremented or derived from site data — guarantees uniqueness even when the same Atlassian site is connected more than once.

### 4.2 Connection Record Shape (existing, for reference)

```
OAuthConnection {
  id: string (UUID)              // primary key = connectionId
  userId: string
  cloudId: string
  siteName: string
  siteUrl: string
  connectionPath: "express"|"manual"
  status: "active"|"degraded"|"expired"|"soft_deleted"|"hard_deleted"
  boardScopeDegraded: boolean
  grantedScopes: string[]
  missingRequiredScopes: string[]
  projectScopeMode: "all"|"selected"
  selectedProjectIds: string[]
  includeArchivedProjects: boolean
  connectedAt: ISO8601
  lastSyncedAt: ISO8601|null
  refreshTokenLastUsedAt: ISO8601
  softDeletedAt: ISO8601|null
  softDeleteRetentionDays: number
  createdAt: ISO8601
  updatedAt: ISO8601
}
```

### 4.3 List Endpoint Filter Logic

`GET /api/v1/integrations` returns all connections where `status !== 'hard_deleted'` by default. The optional `?status=` filter allows targeted queries. The connections page shows a "Deleted" tab for `soft_deleted` items so they can be restored within the retention window.

---

## 5. Component Breakdown

### 5.1 Backend Changes

| File | Change |
|---|---|
| `src/routes/integrations.js` | Add `GET /` handler (list all connections) |
| `src/routes/backup.js` | Add `GET /:id/backup-points` handler |
| `src/app.js` | Change `GET /` redirect from `/connect.html` to `/index.html` |

### 5.2 Frontend New Files

| File | Description |
|---|---|
| `src/public/index.html` | Dashboard landing page |
| `src/public/connections.html` | Multi-connection management page |
| `src/public/backups.html` | Backup history and trigger page |

### 5.3 Frontend Modified Files

| File | Change |
|---|---|
| `src/public/manage.html` | Add global nav bar; add "Back Up Now" section; add "View Backup History" link |
| `src/public/browse.html` | Add global nav bar |
| `src/public/sdi.html` | Add global nav bar |
| `src/public/resilience.html` | Add global nav bar |
| `src/public/connect.html` | Add global nav bar |
| `src/public/callback.html` | Add global nav bar |
| `src/public/styles.css` | Add nav bar styles, card grid styles |

---

## 6. Data Persistence Gap (Installation Mechanism)

### 6.1 Current Problem

All data (connections, backup points, OAuth tokens) is stored in in-memory `Map` objects in `src/db/index.js`. A container restart, image rebuild, or `git pull` + redeploy results in **complete data loss**.

This breaks the installation/upgrade flow: a user who does `git pull && podman-compose up --build` loses all connections and must re-authorize.

### 6.2 Recommended Fix: File-Backed JSON Store

Replace the in-memory Maps with a file-backed store that persists to a named volume path (`/app/data/db.json` or separate files per collection).

**Implementation approach:**
- Wrap `db/index.js` in a thin persistence layer that:
  - On startup: loads JSON from `data/db.json` if it exists.
  - On write: schedules a debounced flush (e.g. 200 ms) to `data/db.json`.
- The `data/` directory is already declared as a named Podman/Docker volume (`backup_data`, `sdi_tmp`, `export_data`). Add `db_data` volume mounting to `/app/data/db`.
- This is additive — no schema migration needed since the data model is already defined.

**Alternative (lower effort):** SQLite via `better-sqlite3` — simpler queries, atomic writes, but adds a native dependency to the build.

**Scope for Sprint 12:** Architect recommendation is file-backed JSON store as the minimum viable fix. SQLite upgrade can be Sprint 13.

---

## 7. Wizard Flow Integration

### 7.1 How Existing Flows Plug In

```
User lands on /index.html (dashboard)
    │
    ├─ "Add Connection" button
    │       └─ /connect.html (OAuth wizard — unchanged)
    │               └─ Atlassian auth → /callback.html
    │                       └─ "Finish Connection" → /connections.html  ← CHANGED
    │                                                 (was manage.html?connectionId=X)
    │
    ├─ "Manage" link on any connection row
    │       └─ /manage.html?connectionId=X (settings page — extended)
    │
    ├─ "Backups" link on any connection row
    │       └─ /backups.html?connectionId=X
    │
    └─ Global nav bar on every page
            └─ Dashboard | Connections | Backups | Browse | SDI | Resilience
```

### 7.2 Callback Redirect Change

After a successful OAuth connection, `callback.html` currently redirects to:
```
/manage.html?connectionId=<uuid>
```

This should be changed to redirect to:
```
/connections.html
```

This gives the user an immediate view of all their connections (including the newly added one) without requiring them to save the manage URL.

Alternatively, redirect to `/manage.html?connectionId=<uuid>` for the detailed settings view of the just-created connection. Both are acceptable; the simpler UX is `/connections.html`.

---

## 8. Architecture Decision Records

### ADR-NAV-001: Static HTML nav bar, no JS framework

**Decision:** Implement the global nav bar as a static `<nav>` block duplicated in each HTML file rather than a shared component system (React, Vue, server-side includes).

**Rationale:** The project is intentionally zero-dependency on the frontend. Adding a JS framework or build step contradicts the existing approach of plain HTML + vanilla JS. Duplication is acceptable at the current page count (8 pages).

**Consequence:** Nav bar updates must be applied to all 8 HTML files. Future migration to a component system remains possible.

---

### ADR-NAV-002: `GET /api/v1/integrations` returns all non-hard-deleted by default

**Decision:** The list endpoint returns `soft_deleted` connections by default (not just `active`). Hard-deleted connections are excluded unconditionally.

**Rationale:** Users may need to restore soft-deleted connections within the 30-day retention window. The connections page should show them in a "Deleted" state with a "Restore" action. Hard-deleted connections are irrecoverable and irrelevant to the UI.

---

### ADR-NAV-003: `backups.html` is the single entry point for backup operations

**Decision:** Backup triggering and backup history are consolidated on `/backups.html`. The `manage.html` page shows only a summary (last backup time + "Back Up Now" shortcut) and links to `backups.html` for the full history.

**Rationale:** Mixing backup management with connection lifecycle settings on `manage.html` creates a cluttered page. Separation of concerns improves discoverability.

---

### ADR-NAV-004: `/callback.html` redirects to `/connections.html` after successful connection

**Decision:** On successful OAuth completion, redirect to `/connections.html` rather than `/manage.html?connectionId=X`.

**Rationale:** `/connections.html` provides immediate orientation — the user sees all their connections and can take any next action. It also avoids the existing bug where navigating to `manage.html` without a `connectionId` shows an error.

---

## 9. Summary of API Gaps

| # | Endpoint | Method | File | Priority |
|---|---|---|---|---|
| 1 | `/api/v1/integrations` | `GET` | `src/routes/integrations.js` | **Blocker** — required by connections page and dashboard |
| 2 | `/api/v1/integrations/:id/backup-points` | `GET` | `src/routes/backup.js` | **Blocker** — required by backups page |

All other endpoints needed by the new pages already exist.

---

## 10. Implementation Checklist for Developers

### Backend (Backend Developer)
- [ ] Add `GET /` to `src/routes/integrations.js` — list all connections
- [ ] Add `GET /:id/backup-points` to `src/routes/backup.js` — list backup points per integration
- [ ] (Optional, recommended) Implement file-backed JSON persistence in `src/db/index.js`

### Frontend (Frontend Developer)
- [ ] Create `src/public/index.html` — dashboard page
- [ ] Create `src/public/connections.html` — connections management page
- [ ] Create `src/public/backups.html` — backup history + trigger page
- [ ] Add global nav bar to all existing HTML pages
- [ ] Extend `src/public/manage.html` with "Back Up Now" section + backup history link
- [ ] Update `src/public/styles.css` with nav bar and grid card styles
- [ ] Update `src/public/callback.html` — change post-connection redirect target to `/connections.html`

### App Routing (Backend Developer)
- [ ] Update `GET /` in `src/app.js` to redirect to `/index.html`

### DevOps (DevOps Engineer)
- [ ] Add `db_data` named volume to `podman-compose.yml` and `docker-compose.yml`
- [ ] Mount `db_data` to `/app/data/db` in the app container

### Documentation (Software Architect)
- [ ] Update `docs/DEMO.md` — revise Section 3 (backup trigger now on connections page / backups page)
- [ ] Update `docs/USER_GUIDE.md` — add navigation overview, connections page, backups page
- [ ] Update `docs/INSTALLATION.md` — note data persistence with named volumes
- [ ] Update `docs/ARCHITECTURE.md` — reference this document
