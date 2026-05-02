# Sprint 24 QA Report — OAuth Reauthentication & Scope Completeness

**Date:** 2026-05-02  
**Sprint:** 24 — OAuth Reauthentication & Scope Completeness  
**Outcome:** ✅ PASS — All 9 E2E test cases pass. Full test suite: 698 tests / 26 suites, zero failures.

---

## Objective

Validate the full reauthentication loop for an existing Atlassian integration:

1. Pre-reauth connection has `BOARD_WRITE_SCOPE_MISSING` (missing `write:board-scope:jira-software`)
2. User initiates reauthentication via `POST /api/v1/integrations/:id/reauthenticate`
3. OAuth consent grants all 21 scopes including `write:board-scope:jira-software`
4. Callback handler updates existing connection **in place** — same UUID, backup history intact
5. Post-reauth restore with board/sprint basket succeeds (0 `AUTH_ERROR`, 0 `*_SCOPE_MISSING`)
6. Custom-field 400 regression from Sprint 23 does not resurface

---

## Test File

`tests/sprint24-reauth-e2e.test.js` — 9 test cases (TC-8 through TC-16)

Companion scope-validation unit tests: `tests/sprint24-scope-validation.test.js` — 7 tests (TC-1 through TC-7)

---

## Test Run Results

| TC | Description | Result |
|----|-------------|--------|
| TC-8 | `POST /api/v1/integrations/:id/reauthenticate` returns `authorizationUrl` and stores `reauthConnectionId` marker in pending state | ✅ PASS |
| TC-9 | OAuth callback reauth path updates tokens in place — connection UUID preserved, scopes upgraded, status = `active` | ✅ PASS |
| TC-10 | Backup points (`backupPoints`) linked to `connectionId` are unchanged after reauth callback | ✅ PASS |
| TC-11 | `REAUTH` lifecycle event written to `db.lifecycleEvents` with correct `actorUserId`, `grantedScopes`, and `occurredAt` | ✅ PASS |
| TC-12 | Post-reauth: `checkGrantedScopes` returns `passed=true` for basket containing `board` + `sprint` + `issue` items | ✅ PASS |
| TC-13 | Custom-field sanitization regression (Sprint 23 fix): `EXCLUDED_CUSTOM_FIELDS` set correctly strips 6 problematic fields before issue create | ✅ PASS |
| TC-14 | `reauthenticate` endpoint returns 404 for unknown connection ID | ✅ PASS |
| TC-15 | `reauthenticate` endpoint returns 404 for hard-deleted connection | ✅ PASS |
| TC-16 | OAuth callback reauth path redirects with `CLOUD_ID_MISMATCH` when the newly granted credentials resolve to a different site than the existing connection | ✅ PASS |

---

## Coverage Summary

### TC-8: Reauthenticate Endpoint

- Verified `authorizationUrl` contains `auth.atlassian.com`
- Verified response includes `state`, `connectionId`, and `expiresAt`
- Verified `db.pendingStates` entry carries `reauthConnectionId = connId` (the in-place-update signal)

### TC-9: In-Place Token Update

- Pre-condition: connection seeded with `SCOPES_NO_BOARD_WRITE` (missing `write:board-scope:jira-software`)
- Axios mocks: `axios.post` → full token response; `axios.get` → accessible-resources with same `cloudId`
- Post-condition: `db.connections.size` unchanged (no new record), `updated.id === connId`, `grantedScopes` contains `write:board-scope:jira-software`, `status === 'active'`, `boardScopeDegraded === false`

### TC-10: Backup History Preservation

- Two `backupPoints` seeded with `integrationId = connId` before reauth
- After callback: both records intact, `integrationId` unchanged

### TC-11: REAUTH Audit Event

- `db.lifecycleEvents` contains exactly one event with `eventType === 'REAUTH'` for the connection
- Event carries `actorUserId`, `metadata.grantedScopes`, `metadata.boardScopeDegraded`, and `occurredAt`

### TC-12: Post-Reauth Scope Gate

- Connection has all 21 scopes after reauth
- `checkGrantedScopes(cloudId, basket, connId)` returns `{ passed: true }` for basket with board + sprint + issue items

### TC-13: Custom-Field Regression

- `EXCLUDED_CUSTOM_FIELDS` = `{ customfield_10019, customfield_10020, customfield_10014, customfield_10000, customfield_10001, customfield_10018 }`
- Verified none of these 6 fields appear in the issue create payload (Sprint 23 400-error fix)

### TC-14 / TC-15: Error Cases

- Unknown ID → 404
- Hard-deleted connection (`hardDeletedAt` set) → 404

### TC-16: CloudId Mismatch Guard

- Accessible-resources mock returns site with `id = 'different-cloud-id'` (≠ connection's `cloudId`)
- Callback redirects to `/callback.html?...&code=CLOUD_ID_MISMATCH`
- Connection record untouched

---

## Scope Manifest Verification (TC-1 through TC-7, from sprint24-scope-validation.test.js)

| TC | Scenario | Result |
|----|----------|--------|
| TC-1 | All 21 scopes granted → `overallStatus = PASS`, `connectionAllowed = true` | ✅ |
| TC-2 | Missing `write:board-scope:jira-software` only → `overallStatus = DEGRADED`, `connectionAllowed = true` | ✅ |
| TC-3 | Missing a required scope → `overallStatus = FAIL`, `connectionAllowed = false` | ✅ |
| TC-4 | `checkGrantedScopes` with board basket + missing write:board-scope → blocking failure `BOARD_WRITE_SCOPE_MISSING` | ✅ |
| TC-5 | `checkGrantedScopes` with board basket + full scopes → `passed = true` | ✅ |
| TC-6 | `checkGrantedScopes` with issue-only basket + missing write:board-scope → `passed = true` (board scope irrelevant) | ✅ |
| TC-7 | `getScopeString()` includes all 21 scopes as a space-separated string | ✅ |

---

## Full Suite Regression

```
Test Suites: 26 passed, 26 total
Tests:       698 passed, 698 total
Time:        5.478 s
```

No regressions introduced.

---

## Key Implementation Locations

| File | Role |
|------|------|
| `src/config/scopes.js` | 21-scope manifest; `BOARD_SCOPES`, `SCOPE_STRING` |
| `src/services/scopeValidation.js` | `validateScopes()`, `getScopeString()` |
| `src/services/validationService.js` | `checkGrantedScopes()`, `RESTORE_SCOPE_REQUIREMENTS` |
| `src/routes/integrations.js` | `POST /:id/reauthenticate` endpoint |
| `src/routes/oauth.js` | `GET /oauth/callback` — reauthentication branch (in-place update, REAUTH event, CLOUD_ID_MISMATCH guard) |
| `src/services/restoreOrchestrator.js` | `EXCLUDED_CUSTOM_FIELDS` (Sprint 23 regression) |
