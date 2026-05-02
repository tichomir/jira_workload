# Restore 400 Diagnosis — Issue Create Failures

**Date:** 2026-05-02  
**Sprint:** 23 — Restore Reliability: Custom Fields & Auth  
**Symptom:** `POST /rest/api/3/issue` returns HTTP 400 for every issue in the basket (both with and without custom fields on retry). Boards fail with AUTH_ERROR.

---

## 1. Root Cause Summary

| Failure | HTTP Status | Root Cause |
|---------|-------------|------------|
| Issue create with custom fields | 400 | Payload contains system-managed / read-only / context-invalid custom fields captured by `fields: '*all'` |
| Issue create retry (no custom fields) | 400 | Epic issue type requires `customfield_10011` (Epic Name) — stripping all custom fields breaks Epic creation |
| Board create | 401 → AUTH_ERROR | `write:board-scope:jira-software` OAuth scope is not in the granted token |

---

## 2. How Read-Only Fields Enter the Payload

`jqlEnumeration.js` fetches every issue using `fields: '*all', expand: 'names'` (line 69). This captures the **complete Jira field set** including system-managed, read-only, and context-dependent fields. All of these are stored verbatim in `db.objectSnapshots`.

`restoreOrchestrator.js` `writeObjectToJira()` then iterates every key in `item.fields` and includes any `customfield_*` key that is non-null in the issue create payload (lines 237-243). No filter is applied. This means Jira rejects the payload because it contains fields it does not allow to be set at create time.

---

## 3. Offending Field Classifications

### 3a. System-Managed / Immutable Fields (always causes 400)

These fields are **never writable** via `POST /rest/api/3/issue`. Jira manages them internally.

| Field ID | Field Name | Why Rejected |
|----------|------------|--------------|
| `customfield_10019` | Rank / Global Rank | System-calculated. Jira manages ranking internally. |
| `customfield_10020` | Sprint | Cannot be set at issue create time via REST API v3. Must use `POST /rest/agile/1.0/sprint/{sprintId}/issue` after issue creation. |
| `customfield_10014` | Epic Link | Deprecated field. Replaced by `parent` field or `customfield_10008` (Epic). Setting it via REST API v3 returns 400. |
| `customfield_10018` | Story Point Estimate (legacy) | Read-only alias; `story_points` must use `customfield_10016` (Story Points) or `customfield_10028` (Story point estimate). |
| `customfield_10015` | Start date (managed) | In some Jira configurations this is system-controlled. |

**Expected Atlassian error text:**
```json
{
  "errorMessages": [],
  "errors": {
    "customfield_10020": "Sprint is not on the board"
  }
}
```
or
```json
{
  "errorMessages": ["Cannot set value of field 'customfield_10019'."],
  "errors": {}
}
```

### 3b. Context-Dependent Fields (causes 400 when option doesn't exist at target)

These fields are writable in principle, but the backed-up **option ID or value** may not exist in the target project's field configuration.

| Field ID | Field Name | Why Rejected |
|----------|------------|--------------|
| `customfield_10033` | Select / Radio buttons | Option IDs are context-scoped; a backed-up option ID won't match the target context's option IDs. |
| `customfield_10034` | Multi-select | Same — option IDs are context-scoped. |
| `customfield_10035` | Cascading Select | Parent option ID must exist before child. Cross-project option IDs differ. |
| `customfield_10028` | Story point estimate | Numeric field — usually safe, but may be absent from project's issue type scheme. |
| `customfield_10000` | Development field | Read-only, managed by Jira Software's dev integrations. |
| `customfield_10001` | Team | Managed by Advanced Roadmaps; not directly settable. |

**Expected Atlassian error text:**
```json
{
  "errorMessages": [],
  "errors": {
    "customfield_10033": "Could not find option with id '10042' for field 'customfield_10033'"
  }
}
```

### 3c. User Reference Fields (causes 400 when account ID doesn't exist at target)

| Field ID | Field Name | Why Rejected |
|----------|------------|--------------|
| `customfield_10X` (user-picker type) | Any user-picker custom field | The backed-up `accountId` must be a member of the target Jira site. Cross-site restores always fail unless the user exists on both sites. |

**Expected Atlassian error text:**
```json
{
  "errorMessages": [],
  "errors": {
    "customfield_XXXXX": "User 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' is not a valid user for this site"
  }
}
```

### 3d. Epic-Specific Issue (root cause of retry-without-custom-fields also failing)

When an issue of type `Epic` is created, Jira **requires** `customfield_10011` (Epic Name). The current fallback in `restoreOrchestrator.js` (lines 377-384) strips **all** `customfield_*` keys from the payload before retry:

```javascript
for (const k of Object.keys(customFields)) {
  delete fallbackPayload.fields[k];
}
```

This removes `customfield_10011` along with the problematic fields. Jira then returns a second 400 because Epic Name is missing. The retry succeeds for Task/Story/Bug but fails for Epic.

**Expected Atlassian error text:**
```json
{
  "errorMessages": [],
  "errors": {
    "customfield_10011": "Epic Name is required."
  }
}
```

---

## 4. Board AUTH_ERROR Root Cause

Board creation (`POST /rest/agile/1.0/board`) requires the `write:board-scope:jira-software` OAuth scope. This scope is **not requested** in the application's OAuth flow.

The token's granted scopes (confirmed from backup error logs, Sprint 3 sprint history):
```
manage:jira-configuration manage:jira-project manage:jira-webhook offline_access
read:board-scope:jira-software read:epic:jira-software read:field:jira
read:issue-type:jira read:issue:jira read:jira-user read:jira-work
read:project:jira read:sprint:jira-software read:user:jira
write:epic:jira-software write:field:jira write:issue:jira
write:jira-work write:project:jira write:sprint:jira-software
```

`write:board-scope:jira-software` is absent. The Jira Agile API returns 401 (not 403) for missing write scopes on board creation. The Axios interceptor in the restore engine refreshes the token and retries, but the refreshed token also lacks the scope — producing the `AUTH_ERROR` message.

The existing code (lines 518-521) catches 400 and 403 and gracefully skips; it does NOT catch 401, which propagates up to the interceptor.

---

## 5. Field Sanitization Rules — Required Backend Fixes

The following sanitization must be applied in `writeObjectToJira()` before constructing the `customFields` object, in addition to the existing null-check filter.

### 5a. Permanent Exclude List (never send these fields to issue create/update)

```javascript
const EXCLUDED_CUSTOM_FIELDS = new Set([
  'customfield_10019', // Rank — system-managed
  'customfield_10020', // Sprint — set post-create via agile API
  'customfield_10014', // Epic Link — deprecated, use parent
  'customfield_10000', // Development field — read-only
  'customfield_10001', // Team — managed by Advanced Roadmaps
]);
```

### 5b. Epic Name Preservation on Retry

The fallback retry that strips custom fields must preserve `customfield_10011` (Epic Name) when the issue type is Epic:

```javascript
const isEpic = (fields.issuetype && (fields.issuetype.name === 'Epic'));
for (const k of Object.keys(customFields)) {
  if (isEpic && k === 'customfield_10011') continue; // preserve Epic Name
  delete fallbackPayload.fields[k];
}
```

### 5c. Option-ID Fields — Strip Instead of Send

For select/multi-select/cascading custom fields where the value is an object with an `id` property (not a plain string/number), the backed-up option ID is context-scoped and will not match the target. These should be excluded from the initial payload unless a field mapping step has been completed:

```javascript
// Exclude option-typed custom fields (value is object with 'id') unless mapped
if (typeof v === 'object' && v !== null && 'id' in v && k.startsWith('customfield_')) {
  // Only include if same-site restore AND field mapping confirmed
  // For now: skip to avoid 400
  continue;
}
```

### 5d. Log the Full 400 Response Body

The current warning log only logs `err.message`. The `err.response.data` (Jira's JSON error body) must be logged to diagnose future failures:

```javascript
console.warn(`[restore] Issue create 400 detail: ${JSON.stringify(err.response.data)}`);
```

### 5e. Board — Graceful Skip for Missing Scope

The board create catch block (lines 517-522) already handles 400/403 with a graceful skip. It must also handle 401 (missing scope) identically — not propagate to the interceptor:

```javascript
if (err.isAxiosError && err.response && [400, 401, 403].includes(err.response.status)) {
  console.warn(`[restore] Board create failed (${err.response.status}), skipping: ${err.message}`);
  return { targetId: uuidv4(), skipped: true };
}
```

---

## 6. Prioritised Fix Plan

| Priority | Fix | Impact |
|----------|-----|--------|
| P0 | Add `EXCLUDED_CUSTOM_FIELDS` permanent exclude list | Eliminates 400 for Sprint/Rank/EpicLink fields on every issue |
| P0 | Log `err.response.data` on 400 | Enables field-level error diagnosis for future failures |
| P1 | Preserve `customfield_10011` on Epic retry | Fixes Epic issue creation in the fallback path |
| P1 | Handle 401 in board catch block as graceful skip | Eliminates AUTH_ERROR cascade; boards are skipped cleanly |
| P2 | Strip option-typed custom fields when unmapped | Prevents option-ID mismatch 400s on cross-project/cross-site restores |
| P3 | Add `write:board-scope:jira-software` to OAuth scope request | Enables board creation for users who re-authorise |
