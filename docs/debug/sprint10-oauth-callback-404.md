# Sprint 10 — OAuth Callback 404 Diagnosis

**Date:** 2026-05-01  
**Reporter:** software-architect-persona  
**Symptom:** After completing Atlassian consent screen, browser lands on  
`https://localhost:4443/oauth/callback?state=...&code=...` and receives:

```json
{"error":"NOT_FOUND","message":"Route GET /oauth/callback not found"}
```

---

## Root Cause

**Path mismatch between the configured redirect URI and the registered Express route.**

### Request path trace

| Hop | Component | Path | Outcome |
|-----|-----------|------|---------|
| 1 | Atlassian | Redirects browser to `https://localhost:4443/oauth/callback` | — |
| 2 | Caddy (port 4443) | `reverse_proxy app:4000` — proxies full path unchanged | OK — Caddy is not the problem |
| 3 | Express (`app.js`) | `app.use('/api/v1/oauth', oauthRouter)` | Only matches `/api/v1/oauth/*` |
| 4 | Express 404 handler | `GET /oauth/callback` matches no route | **404 returned** |

### Why the route is unreachable

The OAuth callback logic is registered in `src/routes/oauth.js` as:

```js
// src/routes/oauth.js, line 236
router.get('/express/callback', async (req, res) => { ... });
```

This router is mounted in `src/app.js` at:

```js
// src/app.js, line 28
app.use('/api/v1/oauth', oauthRouter);
```

This means the callback handler is only reachable at:

```
GET /api/v1/oauth/express/callback
```

The documentation and `.env.example` however instruct users to register and configure:

```
ATLASSIAN_REDIRECT_URI=https://localhost:4443/oauth/callback
```

(see `OAUTH_SETUP.md` lines 101, 180, 185 and `.env.example`)

There is no Express handler for `GET /oauth/callback`. The path `/oauth/callback` is
not mounted anywhere in `app.js`. The 404 handler on line 92 of `app.js` catches it.

---

## Exact Files and Lines That Need to Change

### Fix — Option A (Recommended): Add `/callback` alias to the OAuth router + mount at `/oauth`

**Two-part change:**

**Part 1 — `src/routes/oauth.js`**

Extract the `/express/callback` handler body into a named function and register it on
both `/express/callback` (preserving backward compatibility) and `/callback` (the alias
that matches the redirect URI):

```diff
-router.get('/express/callback', async (req, res) => {
+async function expressCallbackHandler(req, res) {
   // ... existing handler body (lines 236–356) ...
-});
+}
+
+// Canonical API path (existing)
+router.get('/express/callback', expressCallbackHandler);
+
+// Alias: matches ATLASSIAN_REDIRECT_URI=https://localhost:4443/oauth/callback
+// when the router is also mounted at /oauth in app.js (see below).
+router.get('/callback', expressCallbackHandler);
```

**Part 2 — `src/app.js`**

Mount the OAuth router at `/oauth` in addition to `/api/v1/oauth`, so that
`/oauth/callback` resolves via the new `/callback` alias above:

```diff
 // src/app.js, line 28
 app.use('/api/v1/oauth', oauthRouter);
+// Also mount at /oauth so the Atlassian redirect URI /oauth/callback resolves.
+app.use('/oauth', oauthRouter);
```

After this change:
- `GET /oauth/callback` → resolves (used by Atlassian redirect / Caddy path)
- `GET /api/v1/oauth/express/callback` → still resolves (backward-compatible)
- `GET /oauth/express/callback` → also resolves (harmless bonus alias)

---

### Fix — Option B (Minimal, no router change): Direct alias in `app.js` only

If touching the oauth router is undesirable, add a one-line alias in `app.js` before the
404 handler that re-dispatches to the router with the correct sub-path:

```diff
 // src/app.js — insert before line 91 (the 404 handler)
+// Alias: maps GET /oauth/callback → GET /api/v1/oauth/express/callback
+app.get('/oauth/callback', (req, res, next) => {
+  req.url = '/express/callback';
+  oauthRouter(req, res, next);
+});
```

This is slightly less idiomatic (mutating `req.url`) but is a smaller diff.

---

## Secondary Issue: Documentation Consistency

Once the route is fixed, the redirect URI documented and used throughout the project
must be registered consistently in the Atlassian Developer Console.

Currently documented as `/oauth/callback` (correct after the fix above):
- `OAUTH_SETUP.md` lines 101, 180, 185
- `.env.example` line ~30
- `Caddyfile.example` comment line 6, `ATLASSIAN_REDIRECT_URI` example

No changes to these documentation files are required; they already use the correct
intended path `/oauth/callback`. The code was lagging behind the documented intent.

---

## Summary

| # | Finding |
|---|---------|
| 1 | **Root cause:** `GET /oauth/callback` is not registered in Express. The handler exists only at `/api/v1/oauth/express/callback`. |
| 2 | **Caddy is not involved** — it proxies the path verbatim; no config change needed. |
| 3 | **Fix location:** `src/routes/oauth.js` (add `/callback` alias handler) + `src/app.js` (add `/oauth` mount, or add direct alias route). |
| 4 | **Documentation is consistent** with the intended path; no doc changes required. |
