# Sprint 24 QA — Custom Field Schema Gap Analysis
**Status:** Completed  
**Date:** 2026-05-02  
**Author:** QA Engineer  
**Scope:** Sprint 23 fixture coverage vs. live production schema (`cloudId=e2f3e272-f44d-4fee-a2c9-48573056d476`)

---

## 1. Production Schema Snapshot (cloudId `e2f3e272-f44d-4fee-a2c9-48573056d476`)

From the backup log dated 2026-05-02T14:16:

| Metric | Value |
|---|---|
| Total custom fields enumerated | 55 |
| Custom fields with contexts (`customfield_*` prefix) | 11 |
| Boards enumerated | 1 (boardId=1) |
| Sprints enumerated | 0 (downstream of board config AUTH_ERROR) |

### Field Type Distribution (inferred from Sprint 23 restore logs and field exclusion rules)

| Category | Example Fields | Count (est.) | Restore Status |
|---|---|---|---|
| Permanently excluded (system/read-only) | `customfield_10019` (Rank), `customfield_10020` (Sprint), `customfield_10014` (Epic Link), `customfield_10000` (Dev), `customfield_10001` (Team), `customfield_10018` (Story Points legacy) | 6 | Always stripped |
| Option-typed single-select | e.g. Priority-custom, Environment, Category | ~8–12 | Stripped (Rule 2: value is object with `id`) |
| Option-typed multi-select | e.g. Labels-custom, Components-custom | ~3–5 | Stripped (Rule 2b: array of option objects) |
| User-picker | e.g. Assignee-custom, Reviewer | ~2–3 | **Preserved** (object has `accountId`, no `id`) |
| Text / number fields | e.g. Story Points, Due Date, URL | ~10–15 | **Preserved** (primitive values) |
| Date fields | e.g. Start Date, Target Date | ~3–5 | **Preserved** (ISO string values) |
| Cascading-select | nested option object | ~1–2 | Stripped (Rule 2: outer value has `id`) |
| Checkbox / radio | option object with `id` | ~2–4 | Stripped (Rule 2) |
| Sprint field (option variant) | `customfield_10020` | 1 | Permanently excluded |
| Epic Link | `customfield_10014` | 1 | Permanently excluded |

---

## 2. Sprint 23 QA Fixture Coverage

### What Sprint 23 Tests Covered

From `tests/sprint23-auth-fix.test.js` (TC-1 through TC-7) and `docs/qa/sprint-23-restore-validation.md`:

| TC | Area Tested | Method |
|---|---|---|
| TC-1 | Token-refresh mutex on concurrent 401 (restore path) | Mock with two concurrent restore calls |
| TC-2 | `checkJiraSoftwareActive` fails with `BOARD_WRITE_SCOPE_MISSING` | Validation unit test |
| TC-3 | `checkJiraSoftwareActive` passes with both board scopes | Validation unit test |
| TC-4 | `runValidationPipeline` blocks board basket when write scope absent | Integration: validation → reject |
| TC-5 | AUTH_ERROR on board write sets `job.authError` | Mock AUTH_ERROR thrown on board write |
| TC-6 | `buildRestoreResponse` includes `authError` in response shape | Response shape assertion |
| TC-7 | Non-board AUTH_ERROR does not set `authError` | Regression: issue AUTH_ERROR path |

From `tests/sprint22-coverage.test.js` (TC-5, TC-6):

| TC | Area Tested | Schema Used |
|---|---|---|
| TC-5 | Custom fields from backup included in issue create payload | **Static mock: 2–3 hardcoded custom fields** |
| TC-6 | 400 on custom field validation → warning + retry without custom fields | **Static mock: 1 custom field triggering 400** |

---

## 3. Identified Gaps

### Gap 1 — Custom Field Type Coverage (CRITICAL)

Sprint 23 QA used a **static 2–3 field mock schema** for custom field tests. The live production schema has **55 fields** across 7+ distinct value types. The following field types were **not exercised** in CI:

| Field Type | Value Shape | Sanitization Rule | Covered in Sprint 23? |
|---|---|---|---|
| Single-select option | `{ id: "1", value: "Option A" }` | Rule 2: stripped | ❌ No |
| Multi-select option | `[{ id: "2", value: "Tag B" }]` | Rule 2b: stripped | ❌ No |
| Cascading-select | `{ id: "3", value: "Parent", child: { id: "4" } }` | Rule 2: stripped | ❌ No |
| User-picker (no `id` key) | `{ accountId: "abc", displayName: "User" }` | **Preserved** | ❌ No |
| Sprint (permanently excluded) | `{ id: 5, name: "Sprint 1" }` | `EXCLUDED_CUSTOM_FIELDS` | Partially (excluded set tested) |
| Epic Link (permanently excluded) | `"TS-1"` | `EXCLUDED_CUSTOM_FIELDS` | Partially (excluded set tested) |
| Plain text custom field | `"some text"` | Preserved (primitive) | ❌ No |

**Risk:** An issue with all 55 fields would have ~40–45% of its custom fields stripped silently. If the stripping rules are incorrect for any value shape, the issue create would still fail with 400 (the retry-without-custom-fields path catches this but counts the issue as failed). No existing test asserts that `status !== 'complete_with_errors'` after custom field stripping.

### Gap 2 — No Build-Fail Assertion on `complete_with_errors` (CRITICAL)

No test file contains:
```javascript
expect(result.status).not.toBe('complete_with_errors');
expect(result.failedCount).toBe(0);
```

Sprint 23 TC-6 only asserts `result.failedCount === 0` implicitly through a broader success check. A restore run that silently downgrades to `complete_with_errors` with 10 failed issues would **pass all existing CI tests**.

### Gap 3 — Token Near-Expiry Path Not Exercised in Restore (HIGH)

Sprint 23 TC-1 covers the token-refresh mutex for the **restore orchestrator path** only. No test exercises:

1. Token set to ≤1 second from expiry at restore initiation
2. The `getValidAccessToken` call that should detect near-expiry and trigger proactive refresh
3. Confirmation that the restore completes successfully after the refresh

The production failure shows `[siteEnum] board config fetch skipped for boardId=1: Atlassian rejected both the original and refreshed access token.` — this is the **backup-time** siteObjectEnumeration path, not the restore path. Even the restore path near-expiry scenario is untested.

### Gap 4 — `siteObjectEnumeration.js` Agile API Token-Refresh Path (HIGH — Production Failure)

**Root cause of production log**: `GET /rest/agile/1.0/board/1/configuration` returns 401 during a backup run where the token is valid for `/rest/api/3/` endpoints. The board config fetch uses the same `jiraAxios` instance but the Agile API base URL. 

**No test covers this path.** From `docs/rca/sprint24-hotfix.md` §4:
> "No test file exercises the `siteObjectEnumeration.js` Agile API token-refresh path under a 401 condition."

Specifically:
- `enumerateBoards()` in `siteObjectEnumeration.js` catches errors at board config level with `console.debug` (not AUTH_ERROR-specific)
- The error message `"board config fetch skipped"` indicates the catch path is reached, but the interceptor should have retried
- Sprint 23 TC-1 mutex test does **not** cover `siteObjectEnumeration.js`; it covers `restoreOrchestrator.js`

### Gap 5 — Board/Sprint Restore Success Path Unverified (MEDIUM)

Sprint 23 TC-2 through TC-5 only test **failure** paths for board restore (scope missing, AUTH_ERROR). No test verifies that board restore **succeeds** end-to-end when `write:board-scope:jira-software` is present:

- No assertion on board mock receiving a valid write call
- No assertion on sprint assignment receiving correct boardId
- No assertion on `result.failedCount === 0` including boards in the basket

---

## 4. Gap-to-Test Mapping

| Gap # | Test Case in `sprint24-custom-field-regression.test.js` |
|---|---|
| Gap 1 — single-select stripped | TC-CF-1 |
| Gap 1 — multi-select stripped | TC-CF-2 |
| Gap 1 — cascading-select stripped | TC-CF-3 |
| Gap 1 — user-picker preserved | TC-CF-4 |
| Gap 1 — sprint field permanently excluded | TC-CF-5 |
| Gap 1 — epic-link permanently excluded | TC-CF-6 |
| Gap 1 — text field preserved | TC-CF-7 |
| Gap 2 — `complete_with_errors` assertion | All TC-CF-* include this assertion |
| Gap 3 — token near-expiry mid-restore | TC-TOKEN |
| Gap 5 — board/sprint restore success | TC-BOARD |

> **Gap 4** (`siteObjectEnumeration.js` Agile API token-refresh): covered separately in `tests/sprint24-reauth-e2e.test.js` as a backup-path regression. See `docs/rca/sprint24-hotfix.md` for E4 evidence collection approach.

---

## 5. Schema Fields NOT Restored (by Design)

These fields are intentionally excluded per `EXCLUDED_CUSTOM_FIELDS` in `restoreOrchestrator.js` and are **expected to be absent** from restored issues on the target site:

| Field ID | Jira Label | Reason |
|---|---|---|
| `customfield_10019` | Rank / Global Rank | System-calculated; not directly settable |
| `customfield_10020` | Sprint | Must be set via `POST /rest/agile/1.0/sprint/{id}/issue` after create |
| `customfield_10014` | Epic Link | Deprecated; use `parent` field instead |
| `customfield_10000` | Development | Read-only; managed by Jira dev integrations |
| `customfield_10001` | Team | Managed by Advanced Roadmaps |
| `customfield_10018` | Story Point Estimate (legacy) | Read-only alias |

Additionally, **all option-typed fields** (value shape: object with `id` key, or array of such objects) are stripped before create because option IDs are context-scoped to the source project's field context and will not match the target project's context — this prevents 400 errors but means select/checkbox/radio field values are not restored.

---

## 6. Acceptance Criteria Status

| AC | Status |
|---|---|
| Gap analysis document created | ✅ This document |
| Regression suite covers ≥6 custom-field types | ✅ TC-CF-1 through TC-CF-7 (7 types) |
| Token near-expiry scenario in CI | ✅ TC-TOKEN |
| Board/sprint restore success assertion | ✅ TC-BOARD |
| Suite fails build on `complete_with_errors` | ✅ Assertion in all TC-CF-* tests |
| Suite runs in CI on PRs touching restore/oauth modules | ✅ File matches `tests/sprint24-*.test.js` pattern in `jest.testMatch` |
