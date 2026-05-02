# OAuth Scope Manifest — Jira Cloud Integration

**Source of truth:** `src/config/scopes.js`  
**Consumed by:** `src/services/scopeValidation.js` · `src/routes/oauth.js`  
**Updated:** 2026-05-02

---

## Overview

The integration requests **21 Atlassian delegated OAuth 2.0 scopes** — 19 required and 2 optional.  
Optional scopes (both `*:board-scope:jira-software` variants) degrade gracefully:  
their absence sets connection status to `DEGRADED` (board/sprint features disabled) rather than `FAIL`.

---

## Diff vs. Previous Production Scope List (Sprint 1 → Sprint 2)

| Change | Scope | Reason |
|--------|-------|--------|
| ✅ Already present | `read:board-scope:jira-software` | Board backup reads |
| ➕ **Added** | `write:board-scope:jira-software` | Board and sprint **restore** writes — was absent from `SCOPE_MATRIX`, causing `BOARD_WRITE_SCOPE_MISSING` on every restore attempt |

---

## Complete Scope List (21 scopes)

### Authentication

| Scope | Required | Severity if missing |
|-------|----------|----------------------|
| `offline_access` | ✅ Yes | FATAL |

### Issues

| Scope | Required | Severity if missing |
|-------|----------|----------------------|
| `read:jira-work` | ✅ Yes | CRITICAL |
| `write:jira-work` | ✅ Yes | CRITICAL |
| `read:issue:jira` | ✅ Yes | ERROR |
| `write:issue:jira` | ✅ Yes | ERROR |
| `read:issue-type:jira` | ✅ Yes | ERROR |

### Projects

| Scope | Required | Severity if missing |
|-------|----------|----------------------|
| `read:project:jira` | ✅ Yes | ERROR |
| `write:project:jira` | ✅ Yes | ERROR |
| `manage:jira-project` | ✅ Yes | ERROR |

### Users

| Scope | Required | Severity if missing |
|-------|----------|----------------------|
| `read:jira-user` | ✅ Yes | ERROR |
| `read:user:jira` | ✅ Yes | ERROR |

### Custom Fields

| Scope | Required | Severity if missing |
|-------|----------|----------------------|
| `read:field:jira` | ✅ Yes | ERROR |
| `write:field:jira` | ✅ Yes | ERROR |

### Workflows

| Scope | Required | Severity if missing |
|-------|----------|----------------------|
| `manage:jira-configuration` | ✅ Yes | ERROR |

### Epics

| Scope | Required | Severity if missing |
|-------|----------|----------------------|
| `read:epic:jira-software` | ✅ Yes | ERROR |
| `write:epic:jira-software` | ✅ Yes | ERROR |

### Sprints

| Scope | Required | Severity if missing |
|-------|----------|----------------------|
| `read:sprint:jira-software` | ✅ Yes | ERROR |
| `write:sprint:jira-software` | ✅ Yes | ERROR |

### Webhooks

| Scope | Required | Severity if missing |
|-------|----------|----------------------|
| `manage:jira-webhook` | ✅ Yes | ERROR |

### Boards (optional — graceful degradation)

| Scope | Required | Severity if missing |
|-------|----------|----------------------|
| `read:board-scope:jira-software` | ⚠️ Optional | WARNING |
| `write:board-scope:jira-software` | ⚠️ Optional | WARNING |

---

## Scope → Operation Mapping

### Backup Stages

| Backup Operation | Required Scopes |
|-----------------|-----------------|
| JQL issue enumeration (full + incremental) | `read:jira-work`, `read:issue:jira` |
| Issue snapshot (all fields, comments, attachments) | `read:jira-work`, `read:issue:jira` |
| Attachment binary download | `read:jira-work` |
| Project enumeration and config snapshot | `read:project:jira`, `manage:jira-project` |
| JiraWorkflowNode enumeration | `manage:jira-configuration` |
| JiraCustomFieldDefinitionNode enumeration | `read:field:jira` |
| JiraCustomFieldContextNode enumeration | `read:field:jira` |
| Epic snapshot | `read:epic:jira-software` |
| Sprint enumeration (Agile API) | `read:sprint:jira-software` |
| Board enumeration (Agile API) | `read:board-scope:jira-software` *(optional)* |
| Webhook registration (real-time delta) | `manage:jira-webhook` |
| User/assignee/reporter resolution | `read:jira-user`, `read:user:jira` |
| Issue type enumeration | `read:issue-type:jira` |

### Restore Stages

| Restore Stage | Required Scopes |
|--------------|-----------------|
| **Stage 1** — Workflow restore (full definition) | `manage:jira-configuration` |
| **Stage 1** — Custom field definition restore | `read:field:jira`, `write:field:jira` |
| **Stage 1** — Custom field presence validation | `read:field:jira` |
| **Stage 2** — Project create/update | `write:project:jira`, `manage:jira-project` |
| **Stage 2** — Target project existence check | `read:project:jira` |
| **Stage 3** — Issue create/update | `write:jira-work`, `write:issue:jira` |
| **Stage 3** — Existing-issue lookup by key | `read:issue:jira` |
| **Stage 3** — Issue custom field values restore | `write:field:jira` |
| **Stage 3** — Epic assignment restore | `write:epic:jira-software` |
| **Stage 3** — Issue type validation | `read:issue-type:jira` |
| **Stage 4a** — Comment restore (delete + re-create) | `write:jira-work` |
| **Stage 4b** — Board create/update | `write:board-scope:jira-software` *(optional)* |
| **Stage 5** — Sprint create on board | `write:sprint:jira-software`, `write:board-scope:jira-software` *(optional)* |
| **Stage 5** — Sprint→issue assignment | `write:sprint:jira-software` |

---

## Validation Behaviour

| Condition | `overallStatus` | `connectionAllowed` |
|-----------|-----------------|---------------------|
| All 19 required + both board scopes granted | `PASS` | `true` |
| All 19 required granted; one or both board scopes missing | `DEGRADED` | `true` |
| Any required scope missing | `FAIL` | `false` |

When `DEGRADED`:
- Board backup is skipped (no board objects in manifest).
- Board/sprint restore pre-validation raises `BOARD_WRITE_SCOPE_MISSING` (blocking) when the restore basket contains boards or sprints.
- All other backup and restore features operate normally.

---

## Re-Authentication (Scope Upgrade)

When the integration is in `DEGRADED` state and the user wants to enable board/sprint restore:

1. Navigate to **Connections** → select the connection → **Reconnect**.
2. The OAuth flow will request all 21 scopes including both `*:board-scope:jira-software` variants.
3. On grant, scope validation re-runs; status transitions from `DEGRADED` → `PASS`.
4. No data loss — existing backup points and connection metadata are preserved across re-authentication.

> **Note:** Deleting and recreating the connection is NOT required. Re-authentication (reconnect) upgrades scopes in-place.
