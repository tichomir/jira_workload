# Sprint 24 Hotfix — RCA Framing
**Status:** 🔴 Reopened  
**Labels:** `hotfix`, `sprint-24`, `rca`  
**Date:** 2026-05-02  
**Author:** Software Architect

---

## Reopened Tickets

### Ticket 1 — Diagnose 400 errors on issue create with custom fields
- **Closed in:** Sprint 23 (◈ Standard, 3 SP)
- **Reopened as:** Sprint 24 Hotfix item
- **Rationale:** Production backup logs from 2026-05-02 14:16 continue to show board config fetch failures with AUTH_ERROR during the backup phase (not restore), indicating the token-refresh path for board-scoped Agile API calls is still not reliable. The custom-field 400 fix (Sprint 23) was validated only for the *restore* path. The backup-time `siteObjectEnumeration.js` board config fetch does not go through the same graceful-skip handler introduced in Sprint 23, leaving the backup pipeline silently degraded for board metadata.

### Ticket 2 — Fix OAuth token refresh for board/sprint restore stage
- **Closed in:** Sprint 23 (◈ Standard, 3 SP)
- **Reopened as:** Sprint 24 Hotfix item
- **Rationale:** The production log from 2026-05-02 shows `[siteEnum] board config fetch skipped for boardId=1: Atlassian rejected both the original and refreshed access token.` during a **backup** run where the user is authenticated. This contradicts the Sprint 23 closure claim (TC-1: "Token-refresh mutex: concurrent 401s share single refresh call — ✅ PASS"). The test covered the restore orchestrator's token-refresh path but not the backup-time `siteObjectEnumeration.js` Agile API calls, which use a separately constructed `jiraAxios` instance.

---

## 1. Production Log Evidence

### Backup log — 2026-05-02T14:16 (integration `2ff72b4e-7e74-40b6-8f91-523163bb2e3c`)

```
[backup] Enumerated 1 project(s) from Jira API for integration 2ff72b4e-7e74-40b6-8f91-523163bb2e3c
[backup] phase=backup_project integrationId=2ff72b4e-7e74-40b6-8f91-523163bb2e3c projectKey=SCRUM
[jql] start: integrationId=2ff72b4e-7e74-40b6-8f91-523163bb2e3c jql="project="SCRUM" AND updated>="2026-05-02 14:16" ORDER BY updated ASC" total=unknown
[jql] page: pageIndex=1 startAt=0 issuesOnPage=0 runningTotal=0
[jql] end: integrationId=2ff72b4e-7e74-40b6-8f91-523163bb2e3c totalFetched=0 pagesTraversed=1 durationMs=412
[backup] phase=site_enumeration integrationId=2ff72b4e-7e74-40b6-8f91-523163bb2e3c
[siteEnum] enumerating workflows for cloudId=e2f3e272-f44d-4fee-a2c9-48573056d476
[siteEnum] enumerating custom fields for cloudId=e2f3e272-f44d-4fee-a2c9-48573056d476
[siteEnum] custom fields enumerated: count=55
[siteEnum] workflows enumerated: count=3
[siteEnum] enumerating contexts for 11 custom fields
[siteEnum] enumerating boards for cloudId=e2f3e272-f44d-4fee-a2c9-48573056d476
[siteEnum] boards enumerated: count=1
[siteEnum] board config fetch skipped for boardId=1: Atlassian rejected both the original and refreshed access token. Please reconnect the integration from the Connections page.
[siteEnum] sprints enumerated: count=0
[backup] phase=persisting integrationId=2ff72b4e-7e74-40b6-8f91-523163bb2e3c
[backup] Backup record persisted: jobId=3bdca614-cd6f-422d-954a-f5359c93907b
```

**Key observations:**
1. Workflow and custom-field enumeration succeed — these use `/rest/api/3/` endpoints. The access token is valid for those calls.
2. Board list enumeration succeeds (`boards enumerated: count=1`) — `GET /rest/agile/1.0/board` succeeds.
3. Board **config** fetch fails — `GET /rest/agile/1.0/board/1/configuration` returns 401, and the token-refresh interceptor's retry also fails.
4. Sprint enumeration returns 0 because the sprint fetch loop is entered only after a successful config fetch in the current code path.
5. The connection has `write:board-scope:jira-software` in `grantedScopes` (user reauthenticated in Sprint 24) — so the failure is NOT scope-absence; it is a token-refresh mechanics failure specific to the Agile API base URL.

### Prior restore log evidence (Sprint 23 sprint goal)

```
[restore] Failed to write board id=1: AUTH_ERROR — Atlassian rejected both the original and refreshed access token.
[restore] Failed to write board id=34: AUTH_ERROR — ...
[restore] Failed to write board id=67: AUTH_ERROR — ...
```

---

## 2. Hypotheses

### H1 — Agile API base URL excluded from token-refresh interceptor scope (primary)

**Hypothesis:** The `jiraAxios` instance created in `backupEngine.js` / `siteObjectEnumeration.js` attaches the token-refresh interceptor to a base URL of `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...`. The Agile API uses a different base: `https://api.atlassian.com/ex/jira/{cloudId}/rest/agile/1.0/...`. If the interceptor is scoped or if a **separate** axios instance is created for Agile calls without the refresh interceptor, then the first 401 from the Agile API triggers the refresh, but the retry is still sent with the **old token** (race condition between the interceptor storing the new token and the retry request being dispatched), or the retry re-uses a cached pre-refresh token.

**Evidence needed:**
- Read `src/services/siteObjectEnumeration.js` lines where `jiraAxios` is constructed and where `paginateAgile` / `enumerateBoards` diverges from `paginateWithIsLast`.
- Confirm whether both Agile and non-Agile calls share the same interceptor-equipped `jiraAxios` instance.
- Capture the raw 401 response body from the Agile API call to confirm whether Atlassian is saying "token expired" or "scope insufficient".

### H2 — Scope drift on token refresh (secondary)

**Hypothesis:** When the refresh token exchange is performed (POST to `https://auth.atlassian.com/oauth/token`), Atlassian may return a new access token with a reduced scope set that no longer includes `write:board-scope:jira-software` if the user's consent grant has drifted (e.g., Atlassian's consent UI did not persist the optional board scope across refresh cycles). This would explain why the initial token (obtained at reauth time) works for the board list call but the **refreshed** token does not work for the board config call.

**Evidence needed:**
- Log the `scope` claim from the JWT of both the original access token and the refreshed access token to compare.
- Check `tokenService.js` `refreshAccessToken` to confirm whether `grantedScopes` is updated after each refresh and whether `write:board-scope:jira-software` disappears post-refresh.

### H3 — Token-refresh mutex race condition on concurrent Agile calls (tertiary)

**Hypothesis:** `runSiteEnumeration` runs workflows + fields concurrently (`Promise.all`) then boards serially. If a 401 occurs on a concurrent call and triggers a token refresh, a second concurrent call may also trigger a refresh while the first is in flight — resulting in two parallel refresh calls, the second of which invalidates the first's new access token (Atlassian single-use refresh token semantics). The `sprint23-auth-fix.test.js` TC-1 covered this for the restore path, but the backup path may use a different mutex instance.

**Evidence needed:**
- Confirm whether `tokenService.js` `refreshMutex` (or equivalent) is a singleton shared across both backup and restore code paths, or instantiated per-request.
- If it is a singleton, confirm that `siteObjectEnumeration.js` imports and uses the same instance.

### H4 — Custom-field 400 on issue create still occurs for certain field schemas (background)

**Hypothesis:** The Sprint 23 `EXCLUDED_CUSTOM_FIELDS` set strips 6 known problematic fields and option-typed fields. However, the production environment has 55–56 custom fields, and some may have schemas not covered by the current exclusion rules (e.g., `cascadingselect`, `multicheckboxes`, or project-specific fields with server-side validation). The Sprint 23 fix was validated against a static mock schema in `sprint23-auth-fix.test.js` TC-13, not against the live 56-field schema.

**Evidence needed (for task-001 to collect):**
- The raw 400 response body from a failed issue create call (not just the axios error code).
- The exact `fields` payload sent in the failing request (log before the POST).
- The field IDs that cause rejection, cross-referenced against the live `/rest/api/3/field` response.

---

## 3. Evidence to Collect (Task-001 Scope)

The following evidence items are required before fixes can be implemented:

| # | Evidence Item | Collection Method |
|---|---|---|
| E1 | Raw 400 response body from Atlassian on issue create failure | Add `console.error('[restore] issue create 400 body:', JSON.stringify(err.response?.data))` before `restoreOrchestrator.js` fallback retry |
| E2 | Raw 401 response body from Agile API board config fetch | Change `console.debug` in `siteObjectEnumeration.js:223` to `console.error` and include `err.response?.data` |
| E3 | Scope claim of refreshed access token vs original | Log `grantedScopes` returned from `refreshAccessToken` in `tokenService.js` and compare to `connection.grantedScopes` |
| E4 | Whether `jiraAxios` Agile calls share the refresh interceptor | Read `backupEngine.js` and `siteObjectEnumeration.js` to trace the axios instance construction chain |
| E5 | Mutex singleton check | Grep for `refreshMutex` / `isRefreshing` across `tokenService.js`, `backupEngine.js`, `siteObjectEnumeration.js` |
| E6 | Live custom field schema for fields that produce 400 | Call `GET /rest/api/3/field/{fieldId}` for any field ID present in the failed restore payload but absent from `EXCLUDED_CUSTOM_FIELDS` |

---

## 4. Links to Prior QA Evidence

| Sprint | File | Outcome |
|--------|------|---------|
| Sprint 23 closure | `docs/qa/sprint-23-restore-validation.md` | ✅ 7/7 tests pass — but tests mock `jiraAxios` and do not exercise the Agile API base URL path |
| Sprint 24 closure | `docs/qa/sprint-24-reauth-validation.md` | ✅ 9/9 tests pass — TC-13 covers `EXCLUDED_CUSTOM_FIELDS` regression but uses static mock schema, not 56-field live schema |
| Sprint 22 coverage | `tests/sprint22-coverage.test.js` | ✅ 10/10 — boards/sprints mocked; no live Agile 401 path exercised |
| Sprint 23 auth fix | `tests/sprint23-auth-fix.test.js` | ✅ TC-1 covers mutex for restore path only |

**Gap:** No test file exercises the `siteObjectEnumeration.js` Agile API token-refresh path under a 401 condition. The production failure is precisely in that uncovered path.

---

## 5. Acceptance Criteria for Hotfix Resolution

The two hotfix tickets are considered closed only when:

1. **E1–E6 evidence collected** and root cause confirmed as one of H1–H4 (or a newly discovered hypothesis).
2. **A regression test added** that fails before the fix and passes after — specifically targeting the Agile API 401 → refresh → retry path in `siteObjectEnumeration.js`.
3. **Restore `complete_with_errors` count is zero** on a live backup + restore run against the test Jira instance (`cloudId=e2f3e272-f44d-4fee-a2c9-48573056d476`) for projects KS and TS.
4. **Full test suite passes** (currently 698 tests / 26 suites) with no regressions.
