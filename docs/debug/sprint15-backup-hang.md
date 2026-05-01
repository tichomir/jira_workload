# Sprint 15 — Backup Job Hangs Forever: Root Cause & Fix

_Date: 2026-05-01 | Author: software-architect-persona_

## Symptom

A backup job triggered via `POST /api/connections/:id/backup` enters `running` status
and never transitions to `completed` or `failed`. The UI shows:

> Backup in progress  
> Job 68395a23-c315-4022-a748-1c692a159772 running… (started May 1, 2026, 6:58 PM)

## Root Cause

**No HTTP request timeout is configured on any axios call in the backup pipeline.**

`axios` default timeout is `0` — meaning it will wait forever for a server response.
Any single HTTP call that stalls (TCP-level hang, slow server, unreachable endpoint) will
block the entire async backup pipeline indefinitely, because the `await` on that call
never resolves or rejects.

### Code locations responsible

| File | Location | Call | Risk |
|---|---|---|---|
| `src/services/tokenService.js` | `refreshConnectionToken()` line ~70 | `axios.post(ATLASSIAN_TOKEN_URL, ...)` | No timeout |
| `src/services/tokenService.js` | `verifyAndRefreshCloudId()` line ~240 | `axios.get(ATLASSIAN_RESOURCES_URL, ...)` | No timeout |
| `src/services/tokenService.js` | `createJiraAxiosInstance()` line ~170 | `axios.create({ headers: ... })` | No timeout on created instance |
| `src/services/webhookRegistration.js` | `fetchExistingWebhooks()` line ~22 | `axios.get(url, ...)` | No timeout |
| `src/services/webhookRegistration.js` | `registerJiraWebhook()` line ~47 | `axios.post(url, ...)` | No timeout |
| `src/services/attachmentMaterialisation.js` | `downloadAttachmentBinary()` line ~19 | `jiraAxios.get(url, ...)` | No timeout (most likely stall point) |
| `src/services/jqlEnumeration.js` | `fetchIssuePage()` line ~67 | `jiraAxios.get(url, ...)` | No timeout |
| `src/services/siteObjectEnumeration.js` | `paginateWithIsLast()` line ~27 | `jiraAxios.get(url, ...)` | No timeout |

The **most likely stall point** in practice is `downloadAttachmentBinary()` — attachment
content downloads can hang if the Jira attachment endpoint is slow or temporarily
unresponsive. The attachment download loop is sequential (one per attachment, not
parallelised), so a single stalled download blocks everything.

The **second most likely stall point** is `registerJiraWebhook()` — if the
`WEBHOOK_CALLBACK_URL` is unreachable and Atlassian validates it synchronously during
webhook creation, the POST call can hang until the OS-level TCP timeout fires (which
on Linux defaults to 2+ minutes).

## Secondary Issue: No Progress Visibility

The backup job object only tracks `status` (`running` / `completed` / `failed`) but not
which phase the backup is currently executing. The user has no way to see if the backup
is doing JQL enumeration, downloading attachments, or is stuck.

## Reproduction Path

1. Configure a Jira connection with at least one project that has issues with attachments.
2. Trigger a backup via `POST /api/connections/:id/backup`.
3. Block `api.atlassian.com` at the OS/firewall level after the project enumeration
   succeeds (simulate a stalled attachment download).
4. The job stays in `running` state indefinitely — no timeout fires, no error is recorded.

Alternatively: set `WEBHOOK_CALLBACK_URL` to an unreachable URL and observe the backup
hang at the webhook registration phase.

## Fix

Two complementary fixes:

### Fix 1 — Add request timeouts to all axios calls

- `createJiraAxiosInstance`: `timeout: 30000` (30s) on the shared jiraAxios instance
- `attachmentMaterialisation.downloadAttachmentBinary`: `timeout: 120000` (2 min — large files)
- Standalone `axios` calls in `tokenService.js` and `webhookRegistration.js`: `timeout: 15000`

With timeouts in place, any stalled HTTP call throws an `AxiosError` with `code: 'ECONNABORTED'`
after the timeout period. This propagates through `runIntegrationBackup()` to the `.catch()` in
`backup.js` which sets `job.status = 'failed'` and records the error message.

### Fix 2 — Add phase tracking to backup job + structured logging

- `runIntegrationBackup` accepts an optional `jobId` parameter.
- A helper `updateJobPhase(phase)` updates `db.backupJobs[jobId].phase` in-place at each
  major phase boundary so the poll endpoint can expose it.
- `GET /api/v1/integrations/:id/backup/:jobId` now includes `phase` in the response.
- The frontend job status card displays the current phase.
- Structured `console.info` logs added at every major phase boundary in `backupEngine.js`,
  `jqlEnumeration.js`, `siteObjectEnumeration.js`, and `attachmentMaterialisation.js`.

## Files Modified

- `src/services/tokenService.js` — add timeouts to axios calls
- `src/services/webhookRegistration.js` — add timeouts to axios calls
- `src/services/backupEngine.js` — phase tracking, structured logging, jobId param
- `src/services/jqlEnumeration.js` — per-page fetch logging
- `src/services/siteObjectEnumeration.js` — per-phase logging
- `src/services/attachmentMaterialisation.js` — per-attachment logging, extended timeout
- `src/routes/backup.js` — pass jobId to runIntegrationBackup; expose phase in GET response
- `src/public/backups.html` — display phase in active job status card
