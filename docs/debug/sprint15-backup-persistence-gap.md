# Sprint 15 — Backup Persistence Gap: Root Cause Findings

**Date:** 2026-05-01  
**Author:** Software Architect  
**Status:** Root cause confirmed — ready for backend_developer fix

---

## Summary

Backup jobs complete successfully and the GUI shows "Backup completed", but no backup records ever appear in the history list (`/backups.html`) and the `GET /api/v1/integrations/:id/backups` endpoint always returns an empty array.

**Root cause:** `runIntegrationBackup()` in `src/services/backupEngine.js` **never writes a record to `db.backupPoints`**. The in-memory Map `db.backupPoints` is queried by the history endpoint but is never populated by the backup engine.

---

## Exact Code Path — Where the Record Is Dropped

### 1. Trigger path — `src/routes/backup.js:31–61`

```js
// Line 41-44: a backupJobs record IS created correctly
const jobId = uuidv4();
const job = { id: jobId, integrationId, status: 'running', ... };
db.backupJobs.set(jobId, job);

// Line 47: backup engine is called
runIntegrationBackup(integrationId).then((result) => {
  job.status = 'completed';           // ← job is marked done
  job.completedAt = new Date().toISOString();
  job.result = result;
  db.backupJobs.set(jobId, job);      // ← only the JOB record is updated
  // *** db.backupPoints.set() is NEVER called here ***
}).catch(...)
```

### 2. Engine path — `src/services/backupEngine.js:66–125`

`runIntegrationBackup()` does the following:
- Lines 75–83: registers webhook (if scope present)
- Lines 86–95: determines project keys
- Lines 98–103: calls `runProjectBackup()` per project
- Line 105: calls `runSiteEnumeration()`
- Lines 107–111: updates `connection.lastSyncedAt` on the connection record
- Lines 113–124: **returns a result object**

**At no point in this function is `db.backupPoints.set(...)` called.**

Inside `runProjectBackup()` (lines 31–55), a `backupPointId` is generated (line 33):
```js
const backupPointId = uuidv4();
```
This ID is used only as a key for attachment manifest entries and is returned in the result. **It is never registered in `db.backupPoints`.**

### 3. History query path — `src/routes/backup.js:113–145`

```js
function listBackupPoints(req, res) {
  const points = [];
  for (const bp of db.backupPoints.values()) {   // ← iterates the Map
    if (bp.integrationId !== integrationId) continue;
    points.push({ ... });
  }
  // db.backupPoints is always empty → points is always [] → returns empty array
  return res.status(200).json({ integrationId, backupPoints: [], total: 0, ... });
}
```

This handler is mounted at both `GET /api/v1/integrations/:id/backups` and `GET /api/connections/:id/backups` (via `app.js:99`).

---

## ConnectionId Mismatch Analysis

The connectionId used for the backup trigger and the connectionId used for the history query are **the same**. The `integrationId` flows from `req.params.id` in both cases. No mismatch exists. The empty history is caused entirely by the missing write to `db.backupPoints`, not by an ID mismatch.

---

## Issue Classification

| Dimension | Finding |
|---|---|
| **Root cause location** | `src/services/backupEngine.js` — `runIntegrationBackup()`, no `db.backupPoints.set()` call |
| **Secondary location** | `src/routes/backup.js:47–58` — job completion handler also does not create backup point |
| **Storage write missing?** | Yes — `db.backupPoints` Map is never written during a backup run |
| **Job completion handler correct?** | Yes — `db.backupJobs` is updated correctly; only backup point record is absent |
| **History query correct?** | Yes — correctly queries `db.backupPoints` by `integrationId`; returns empty because Map is empty |
| **ConnectionId mismatch?** | No — same ID used throughout |

---

## Fix Required — for backend_developer

In `src/services/backupEngine.js`, `runIntegrationBackup()` must write a `BackupPoint` record to `db.backupPoints` after all project backups complete.

**Minimum required shape** (from `db/index.js` comment at line 83):
```
{ id, integrationId, createdAt, priorBackupPointId }
```

**Expanded shape** (used by `backup.js:listBackupPoints` at lines 121–130):
```js
{
  id,                      // uuid
  integrationId,           // from function param
  createdAt,               // ISO timestamp
  priorBackupPointId,      // id of the most recent prior backup point for this integration (or null)
  status: 'completed',
  objectCounts: {
    issues: <total issue count across all projects>,
    workflows: siteEnumResult.workflows.length,
    customFieldDefinitions: siteEnumResult.fields.length,
    attachments: <total attachment entries>,
  }
}
```

**Where to insert in `backupEngine.js`:** After line 111 (`db.connections.set(integrationId, connection)`), before the `return` statement:

```js
// Determine priorBackupPointId
const priorPoint = [...db.backupPoints.values()]
  .filter(bp => bp.integrationId === integrationId)
  .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

const backupPointId = uuidv4();
const totalIssues = projectResults.reduce((sum, pr) => sum + (pr.issues ? pr.issues.length : 0), 0);
const totalAttachments = projectResults.reduce((sum, pr) => sum + (pr.attachmentEntries ? pr.attachmentEntries.length : 0), 0);

const backupPoint = {
  id: backupPointId,
  integrationId,
  createdAt: now,
  priorBackupPointId: priorPoint ? priorPoint.id : null,
  status: 'completed',
  objectCounts: {
    issues: totalIssues,
    workflows: siteEnumResult.workflows.length,
    customFieldDefinitions: siteEnumResult.fields.length,
    attachments: totalAttachments,
  },
};
db.backupPoints.set(backupPointId, backupPoint);
db.saveDb();   // persist immediately so data survives restart
```

---

## Files Relevant to the Fix

| File | Role |
|---|---|
| `src/services/backupEngine.js` | **Primary fix location** — add `db.backupPoints.set()` call |
| `src/routes/backup.js` | History endpoint — no change needed; already queries `db.backupPoints` correctly |
| `src/db/index.js` | `backupPoints` Map definition — no change needed |
| `src/db/persist.js` | `saveDb()` — no change needed |
