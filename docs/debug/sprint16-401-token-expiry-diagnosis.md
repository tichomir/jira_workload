# Sprint 16 — 401 Unauthorized Diagnosis: Stale Access Token on Backup

_Date: 2026-05-01_

---

## Summary

Every backup attempt after the first hour of a connection's lifetime fails with HTTP 401
(`FAILURE_CLIENT_AUTH`) against `api.atlassian.com`. The root cause is that
**no token refresh mechanism exists** in the codebase. The access token is decrypted
once at the start of `runIntegrationBackup` and passed through the entire backup pipeline
with no expiry check and no retry-on-401 logic.

---

## Token Expiry Window vs Backup Job Duration

From the JWT payload present in all three failing log excerpts
(Sprint 14 at 13:55 UTC, Sprint 16 at 14:52 UTC and 14:54 UTC):

| Field | Value | Wall-clock |
|---|---|---|
| `iat` | 1777643248 | 2026-05-01 ~14:47 UTC |
| `exp` | 1777646848 | 2026-05-01 ~15:47 UTC |
| Window | **3,600 s (1 hour)** | — |

The **identical** bearer token string appears across all three log excerpts, meaning the
token stored in the DB at connection time was never refreshed between backup runs.  
The 14:52 UTC run fails because the token's 1-hour TTL has elapsed since the prior
successful exchange.

---

## Exact Code Path Responsible

### 1. `backupEngine.js` — token fetched once, never checked or refreshed

```
runIntegrationBackup(integrationId)          // line 66
  connection = db.connections.get(id)        // line 67
  accessToken = getAccessToken(connection)   // line 73  ← decrypt only, no expiry check
  ...
  runSiteEnumeration(cloudId, accessToken)   // line 105 ← stale token passed through
```

`getAccessToken()` (lines 17–19) calls only `decrypt(connection.accessToken)`.
It reads `connection.accessTokenExpiresAt` **nowhere**. There is no branch that checks
whether the token is within its validity window before use.

The `connection` object carries `accessTokenExpiresAt` (set by `finalizeConnection` in
`oauth.js:141`) but nothing ever reads it at backup time.

### 2. `siteObjectEnumeration.js` — raw axios, no retry, no refresh

```
runSiteEnumeration(cloudId, accessToken)     // line 163
  Promise.all([
    enumerateWorkflows(cloudId, accessToken) // line 165 → paginateWithIsLast → axios.get
    enumerateCustomFields(cloudId, accessToken) // line 165 → axios.get (line 76)
  ])
  → enumerateCustomFieldContexts(...)        // line 179 → paginateWithIsLast → axios.get
```

`paginateWithIsLast()` (lines 23–38) issues raw `axios.get` calls.
There is no `catch` for 401, no interceptor, no token-refresh retry.  
When the token is stale, the 401 propagates immediately up the call stack and the entire
backup job fails.

### 3. `jqlEnumeration.js` — same pattern

`jqlEnumeration.js` also uses raw `axios.get` with the passed-in access token and has no
retry-on-401 logic.

---

## Root Cause Classification

This is **scenario (a)**: the access token expires mid-backup (or before the second run
begins) and the refresh token flow is **never invoked** at all. There is no code path
that calls the Atlassian token endpoint with `grant_type: refresh_token` outside of the
initial OAuth exchange in `oauth.js`.

Scenarios (b) and (c) are ruled out:
- (b) Stale/revoked refresh token — the same raw access token (not a failed refresh
  attempt) is being used, so the refresh path was never reached.
- (c) Concurrent token sharing — only one backup job runs at a time per connection; the
  401 occurs on sequential runs with the same stored token.

---

## Fix Strategy

### Decision: Proactive refresh + per-call retry-on-401 interceptor (hybrid)

A **single shared Axios instance with a response interceptor** is the correct pattern
because:

1. Proactive-only (check at backup start) fails for jobs that run >1 hour — the token
   can expire mid-enumeration even after a successful pre-flight refresh.
2. Retry-only (intercept on 401) is the right safety net but adds latency on every
   expiry event; combining with a pre-flight check avoids the first wasted request.

#### Required changes

**New service: `src/services/tokenService.js`**

Responsibilities:
- `refreshConnectionToken(connectionId)` — calls `https://auth.atlassian.com/oauth/token`
  with `grant_type=refresh_token`, updates `connection.accessToken`,
  `connection.accessTokenExpiresAt`, `connection.refreshTokenLastUsedAt` in `db`, calls
  `db.saveDb()`.
- `getValidAccessToken(connectionId)` — checks `connection.accessTokenExpiresAt`; if
  within a 5-minute buffer, calls `refreshConnectionToken` first; returns the decrypted
  fresh token.

**`backupEngine.js` — replace `getAccessToken` call**

```diff
- const accessToken = getAccessToken(connection);
+ const accessToken = await getValidAccessToken(integrationId);
```

This adds a proactive check at backup start.

**Shared Axios instance in `siteObjectEnumeration.js` and `jqlEnumeration.js`**

Replace the raw module-level `axios` usage with a connection-aware instance that has a
response interceptor:

```
On 401 response:
  1. Call refreshConnectionToken(connectionId)
  2. Update request Authorization header with new token
  3. Retry the original request once
  4. If retry also 401 → throw so the job fails with a clear error
```

Because `connectionId` must be available in the interceptor, it should be threaded as
a parameter into `runSiteEnumeration(cloudId, accessToken, connectionId)` and
`runJqlEnumeration(...)`.

**`oauth.js` — no changes required** — the `finalizeConnection` already stores
`accessTokenExpiresAt` and the encrypted `refreshToken`; both are already available on
the connection object.

---

## Token Refresh API Call

```
POST https://auth.atlassian.com/oauth/token
Body:
  grant_type: "refresh_token"
  client_id:  connection.clientId || process.env.ATLASSIAN_CLIENT_ID
  client_secret: decrypt(connection.clientSecret) || process.env.ATLASSIAN_CLIENT_SECRET
  refresh_token: decrypt(connection.refreshToken)

Response (same shape as initial exchange):
  access_token, refresh_token, expires_in, scope
```

The new `refresh_token` in the response must replace the stored one (Atlassian issues a
new refresh token on each use under offline_access / rotating token policy).

---

## Browse / Restore Issues (secondary observations from the sprint goal)

The user also reports:
- **Cannot browse backed-up data** — objects are stored in in-memory Maps
  (`db.workflowNodes`, `db.customFieldContextNodes`, etc.) but the browse endpoints need
  to be verified to query those Maps correctly for a given backup point.
- **Restore appears to succeed but Jira shows no data** — the `restoreOrchestrator.js`
  path also calls Jira APIs with the same stale token; once the token refresh fix is
  applied, restore operations will need the same `getValidAccessToken` pattern.

These are separate issues but share the same root cause: no token lifecycle management.

---

## Acceptance Checklist

- [x] Exact function responsible identified: `getAccessToken` in `backupEngine.js:17-19`
      and the raw axios calls in `siteObjectEnumeration.js:28`, `:76`, `:110`
- [x] Fix strategy documented: proactive `getValidAccessToken` at backup start +
      retry-on-401 Axios interceptor threading `connectionId` through enumeration layer
- [x] Token expiry window quantified: 3,600 s (iat–exp delta), backup can easily exceed
      this for tenants with many projects, workflows, or custom fields
- [x] Pattern decision recorded: hybrid (proactive check + interceptor), not pure
      proactive or pure interceptor, because single proactive check does not protect
      against mid-job expiry on long-running backups
