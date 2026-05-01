# Sprint 10 — OAuth Callback QA Report

**Sprint:** 10  
**Date:** 2026-05-01  
**QA Engineer:** qa-engineer-persona  
**Scope:** OAuth 3LO callback route alias fix — `GET /oauth/callback`  
**Test file:** `tests/sprint10.test.js`

---

## Summary

| Metric | Value |
|--------|-------|
| Test cases executed | 24 |
| Passed | 24 |
| Failed | 0 |
| Regressions introduced | 0 (full suite: 464/464 pass) |
| Blocker defects | 0 |
| Observations | 1 (non-blocking — documented below) |

---

## Problem Statement

After completing the Atlassian consent screen, the browser was redirected to:

```
https://localhost:4443/oauth/callback?state=...&code=...
```

And received the following JSON error instead of proceeding:

```json
{"error":"NOT_FOUND","message":"Route GET /oauth/callback not found"}
```

**Root cause (from `docs/debug/sprint10-oauth-callback-404.md`):**  
The OAuth callback handler was only registered at `/api/v1/oauth/express/callback`.  
The path `/oauth/callback` — which Atlassian uses for the redirect URI — was not mounted in Express.

---

## Fix Validated

Two code changes were applied and are present in the working tree:

| File | Change |
|------|--------|
| `src/routes/oauth.js` | Extracted handler into `expressCallbackHandler` function; registered alias `router.get('/callback', expressCallbackHandler)` at line 363 |
| `src/app.js` | Added `app.use('/oauth', oauthRouter)` at line 30 so the `/callback` alias is reachable at `/oauth/callback` |

After the fix, three equivalent paths all invoke the same handler:
- `GET /oauth/callback` ← Atlassian redirect URI path (previously 404)
- `GET /oauth/express/callback` ← bonus alias via `/oauth` mount
- `GET /api/v1/oauth/express/callback` ← canonical API path (backward compat)

---

## Test Cases

### TC-1: Happy Path — `GET /oauth/callback`

| # | Test | Result |
|---|------|--------|
| 1.1 | Returns 302 redirect to success page, not a 404 `NOT_FOUND` JSON response | PASS |
| 1.2 | Redirect location contains `status=success` | PASS |
| 1.3 | Tokens stored encrypted (not plaintext); 3-segment dot-separated base64 format | PASS |
| 1.4 | State record consumed (deleted) after first use — one-time use enforced | PASS |

**Verdict:** Happy path fully operational. The browser no longer sees the `NOT_FOUND` JSON error.

---

### TC-2: cloudId Resolution from accessible-resources

| # | Test | Result |
|---|------|--------|
| 2.1 | `cloudId` from `accessible-resources` stored in connection record | PASS |
| 2.2 | `CloudSite` record created with resolved `cloudId` and linked `connectionId` | PASS |
| 2.3 | `connectionId` in redirect URL matches stored connection record | PASS |
| 2.4 | `axios.get` called once, targeting `accessible-resources`, with `Authorization: Bearer <token>` | PASS |

**Verdict:** cloudId resolution from `/oauth/token/accessible-resources` is correct end-to-end.

---

### TC-3: Invalid / Tampered State Parameter

| # | Test | Result |
|---|------|--------|
| 3.1 | Unknown `state` param → `STATE_INVALID` redirect; no connection stored | PASS |
| 3.2 | Missing `state` param entirely → `STATE_INVALID` redirect | PASS |
| 3.3 | Missing `code` param entirely → `STATE_INVALID` redirect; no token exchange | PASS |
| 3.4 | Expired state → error redirect (see Observation O-1 below); no token exchange | PASS |
| 3.5 | Tampered state (one character appended) → `STATE_INVALID`; no connection stored | PASS |

**Verdict:** State mismatch is reliably rejected. No tokens are exchanged on any invalid-state path.

---

### TC-4: Expired / Invalid Authorization Code

| # | Test | Result |
|---|------|--------|
| 4.1 | Token exchange failure (Atlassian `400 invalid_grant`) → `TOKEN_EXCHANGE_FAILED` redirect | PASS |
| 4.2 | Token exchange failure (network timeout) → redirect, not a `500 INTERNAL_ERROR` | PASS |
| 4.3 | Reused code (state already consumed on first use) → `STATE_INVALID` on second attempt | PASS |
| 4.4 | `accessible-resources` failure after token exchange → `ACCESSIBLE_RESOURCES_FAILED` redirect | PASS |

**Verdict:** All token exchange failure modes return user-facing redirects; no unhandled exceptions observed.

---

### TC-5: Route `/oauth/callback` Does Not 404

| # | Test | Result |
|---|------|--------|
| 5.1 | Valid params → 302, not 404 | PASS |
| 5.2 | Bad state → 302 redirect (error), not 404 | PASS |
| 5.3 | Atlassian `error=access_denied` param → `ACCESS_DENIED` redirect, not 404 | PASS |
| 5.4 | Canonical `/api/v1/oauth/express/callback` still works (backward compat) | PASS |
| 5.5 | `/oauth/express/callback` alias works via the `/oauth` mount | PASS |

**Verdict:** The `NOT_FOUND` JSON error is eliminated. The route is registered and handles all code paths via redirect.

---

### TC-6: HTTPS Redirect URI — Caddy Local Dev URL

| # | Test | Result |
|---|------|--------|
| 6.1 | `https://localhost:4443/oauth/callback` accepted as valid redirect URI | PASS |
| 6.2 | `http://localhost:4443/oauth/callback` rejected with `INVALID_REDIRECT_URI` | PASS |

**Verdict:** Caddy HTTPS local dev URL is correctly accepted; HTTP variant correctly rejected.

---

## Observations

### O-1: `STATE_EXPIRED` Code Path Is Effectively Unreachable

**Severity:** Informational (non-blocking)

`oauth.js` contains two guards for expired states:

1. `db.pruneExpiredStates()` — called at the top of the callback handler; removes all expired states from the in-memory store.
2. `if (new Date(stateRecord.expiresAt) < new Date())` — a belt-and-suspenders check that returns `STATE_EXPIRED`.

Because `pruneExpiredStates()` always runs first, any already-expired state is deleted before the second check can find it. The second check would only fire in a sub-millisecond race condition (not possible in single-threaded Node.js). In practice, expired states return `STATE_INVALID` (state not found), not `STATE_EXPIRED`.

**Impact:** From a user perspective, both responses communicate the same problem ("re-authorize"). The `STATE_EXPIRED` error code and its corresponding UI message (`'The authorization request timed out (10 minutes). Please try again.'` in `callback.html`) are never surfaced.

**Recommendation:** Either remove the redundant expiry check in `oauth.js` (simplification) or move `pruneExpiredStates()` to after the individual state lookup so the more descriptive `STATE_EXPIRED` error can be surfaced. Not a blocker for this sprint.

---

## Regression Check

Full test suite run after adding Sprint 10 tests:

```
Test Suites: 7 passed, 7 total
Tests:       464 passed, 464 total
```

No regressions in Sprints 1–6 test suites.

---

## Acceptance Criteria Sign-off

| Criterion | Status |
|-----------|--------|
| Happy-path OAuth flow completes without any 404 or NOT_FOUND error | PASS |
| State mismatch rejected with clear error; no tokens stored | PASS |
| Invalid code exchange returns user-facing error, not unhandled exception | PASS |
| cloudId resolved and stored after successful token exchange | PASS |
| QA report committed to `docs/qa/sprint10-oauth-callback-qa.md` | PASS |

**Overall verdict: PASS — all acceptance criteria met.**
