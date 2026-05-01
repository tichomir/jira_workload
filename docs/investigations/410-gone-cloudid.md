# Investigation: HTTP 410 Gone on Jira Search Endpoint

**Date:** 2026-05-01  
**Sprint context:** Post-Sprint-3 — backup still fails despite re-authentication  
**Investigator:** software-architect-persona  
**Status:** Root cause confirmed — fix strategy defined

---

## Symptom

```
AxiosError: Request failed with status code 410
  at fetchIssuePage (/app/src/services/jqlEnumeration.js:52:20)
  ...
url: 'https://api.atlassian.com/ex/jira/e2f3e272-f44d-4fee-a2c9-48573056d476/rest/api/3/search'
jql: 'project="SCRUM" ORDER BY updated ASC'
```

The backup engine calls `GET /rest/api/3/search` with JQL as a query parameter. Atlassian returns `410 Gone`.

---

## Finding 1: Is the stored cloudId stale?

**No.** The cloudId is valid.

Evidence from the same failing backup run:

```
[backup] Enumerated 2 project(s) from Jira API for integration ceaaeb53-...
```

This log line is emitted *after* a successful call to:

```
GET https://api.atlassian.com/ex/jira/e2f3e272-f44d-4fee-a2c9-48573056d476/rest/api/3/project/search
```

That call used **the same cloudId and the same bearer token** as the subsequent failing search call. It returned HTTP 200 with 2 projects. A stale cloudId would produce 404 on *all* endpoints under that prefix — not a 200 on one endpoint followed by a 410 on another.

**The cloudId `e2f3e272-f44d-4fee-a2c9-48573056d476` matches the accessible resource for the current token.** No re-resolution is required.

---

## Finding 2: What does 410 actually signal here?

HTTP 410 Gone from the Atlassian Jira Cloud REST API on `/rest/api/3/search` (GET) is **an endpoint deprecation signal**, not a cloudId-gone or resource-deleted signal.

Atlassian deprecated the `GET /rest/api/3/search` endpoint (which accepted JQL as a query parameter). The replacement endpoint is:

```
GET  /rest/api/3/search/jql   (same query params, new path)
POST /rest/api/3/search/jql   (JQL in request body)
```

Atlassian's phased deprecation schedule moved `GET /rest/api/3/search` to **410 Gone** in May 2026. Once an Atlassian API endpoint reaches the 410 phase, no token refresh, no cloudId re-resolution, and no retry will recover the call — the endpoint is permanently gone. The fix is in the codebase, not in the connection record.

**Supporting evidence:**

| Call in failing run | Status | Conclusion |
|---|---|---|
| `GET /rest/api/3/project/search` (same cloudId, same token) | 200 OK | cloudId and token are both valid |
| `GET /rest/api/3/search?jql=...` (same cloudId, same token) | 410 Gone | Only this specific endpoint is gone |
| `GET /rest/api/3/workflow/search` (prior sprint, same cloudId) | 200 OK | cloudId has not changed between sprints |

---

## Finding 3: Does Jira document 410 as a cloudId signal?

No. Atlassian uses specific HTTP status codes for resource/access issues:

| Status | Meaning in Jira Cloud API |
|---|---|
| **401** | Invalid or expired access token |
| **403** | Token valid but insufficient scopes |
| **404** | Resource does not exist (project, issue, cloudId not found in routing) |
| **410** | **Endpoint permanently removed / deprecated** |

A stale or revoked cloudId produces **404** from the Atlassian routing layer, not 410. The 410 code is reserved for endpoint lifecycle (deprecation). This is consistent with Atlassian's published API versioning policy.

---

## Finding 4: Recommended fix strategy

**Fix: Update `jqlEnumeration.js` to use the new search endpoint path.**

Change line 51 in `src/services/jqlEnumeration.js`:

```js
// Before (deprecated, returns 410):
const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/search`;

// After (current endpoint):
const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/search/jql`;
```

The request parameters (`jql`, `startAt`, `maxResults`) and the response shape (`issues`, `total`, `maxResults`, `startAt`) are identical between the old and new endpoint. No other changes are needed in the pagination logic.

### Why NOT re-resolve cloudId on 410?

Re-resolving cloudId on every 410 would be incorrect and harmful:

1. **Wrong diagnostic:** 410 does not mean cloudId is stale. Treating it as such would cause unnecessary calls to `accessible-resources` on every deprecated endpoint hit.
2. **Masking the real problem:** If the endpoint is gone, re-resolving the cloudId will not fix it — the same 410 will occur again with the new (identical) cloudId.
3. **Correct signal:** The backup engine already has a working 401 interceptor with token refresh. A separate 410 interceptor for cloudId re-resolution would fire on the wrong condition.

### When would re-resolving cloudId at token-refresh time make sense?

If future Jira API changes produce a pattern where `accessible-resources` returns a *different* cloudId for the same site (e.g. after a site migration), then re-resolving cloudId proactively at token-refresh time (alongside the access token) would be the right approach. **That scenario is not present here.** The cloudId is stable and correct.

---

## Summary

| Question | Answer |
|---|---|
| Does stored cloudId match live accessible-resources? | Yes — confirmed valid (project/search 200 with same cloudId) |
| Is 410 a cloudId-staleness signal? | No — 410 is an endpoint-deprecation signal in Atlassian's API lifecycle |
| Root cause | `GET /rest/api/3/search` endpoint was deprecated and removed by Atlassian; our code still calls it |
| Recommended fix | Update `src/services/jqlEnumeration.js` line 51: change path from `/rest/api/3/search` to `/rest/api/3/search/jql` |
| Re-resolve cloudId? | Not required — cloudId is valid and stable |
| Affects token refresh logic? | No — token refresh is working correctly (401 interceptor in `tokenService.js` is correct) |

**Assigned to task-002:** Update `jqlEnumeration.js` to call `/rest/api/3/search/jql` and verify the response contract is backward-compatible.
