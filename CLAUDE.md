# CLAUDE.md — Project History & Conventions

## Project
**jira_workload** — Jira Cloud workload analytics integration platform.

## Sprint History

### Sprint 1 — Authentication and Connection (2026-04-30)
**Goal:** Establish Atlassian OAuth 2.0 (3LO) integration for Jira Cloud.

**Architect:** software_architect

**Deliverables produced:**
- `docs/architecture/oauth-architecture.md` — Complete OAuth 2.0 3LO architecture:
  - Sequence diagrams (Express path + Manual path)
  - 20-scope permission matrix with per-scope remediation messages
  - Graceful degradation contract for missing `read:board-scope:jira-software`
  - Data models: OAuthConnection, CloudSite, ScopeValidationResult, IntegrationLifecycle
  - Backend API contract for all sprint endpoints
  - Multi-site selection logic
  - Refresh token expiry alert thresholds

**Key decisions:**
- Token storage uses encrypted-at-rest fields (AES-256-GCM); never logged or serialized to client.
- `read:board-scope:jira-software` is the only optional scope; its absence triggers a non-blocking banner and excludes Board/Sprint data rather than failing the connection.
- Hard Delete is sandbox-only; production enforces Soft Delete with 30-day retention.
- cloudId resolution always calls `/oauth/token/accessible-resources`; the response is cached per OAuthConnection.
- Refresh token inactivity threshold is 90 days (Atlassian default); proactive alert fires at 80 days (10-day advance warning).

### Sprint 4 — Restore Engine (2026-04-30)
**Goal:** Implement the full point-in-time restore pipeline.

**Architect:** software_architect

**Deliverables produced:**
- `docs/architecture/restore-engine-architecture.md` — Full restore engine architecture:
  - Dependency-ordered execution graph (5 stages with inter-stage rules)
  - Conflict mode state machine (Skip/Override/Ask with >50-item basket suppression)
  - Restore destination router (original, alternate/cross-site, JSON+ZIP export)
  - Cross-site custom field ID mapping step interface
  - Pre-execution validation pipeline (7 checks, blocking/non-blocking classified)
  - Permanent API constraint handlers (key label stamping, reporter header, comment author ADF header, full workflow definition)
  - Typed API contracts for all restore endpoints
  - 5 ADRs covering key decisions
- `packages/shared-types/src/restore.ts` — Typed interfaces exported for backend and frontend consumption

**Key decisions:**
- `merge` conflict mode permanently excluded (ADR-001): deep merge across Jira object schemas risks silent data corruption.
- `ask` mode downgraded to `skip` when basket >50 items server-side (ADR-002): UX latency and error risk.
- Full workflow JSON always supplied to create/update API; no property-level patching (ADR-003).
- Comment author and reporter attribution via ADF header prepend, not API fields (ADR-004): Jira Cloud API does not allow setting `author` to arbitrary users.
- Cross-site custom field mapping is a blocking gate for required fields (ADR-005): silent field ID mismatch would corrupt restored issues.

### Sprint 5 — Sensitive Data Intelligence (SDI) Teaser (2026-04-30)
**Goal:** Deliver SDI teaser module scanning backed-up Jira data for sensitive data elements.

**Architect:** software_architect

**Deliverables produced:**
- `docs/architecture/sdi-architecture.md` — Full SDI teaser pipeline architecture:
  - End-to-end pipeline diagram: backup storage → file enumerator → file extractor → pattern scanner → findings aggregator → regulation mapper → results API
  - Detection patterns for all four data element types (Email, Credential/API Key, Credit Card/PAN, Phone Number) with positive and negative test examples
  - File-type extraction strategy for all 13 supported file types (text-native direct read; binary extraction for .pdf via pdf-parse and .docx via OOXML unzip)
  - Regulation mapping schema: GDPR/CCPA/PCI DSS as Active; DORA/NIS2/SOC 2 as Shown; HIPAA explicitly excluded with rationale
  - Findings data model: SdiScanHit (in-memory only), SdiFindingSummary (persisted), SdiScanResult (top-level)
  - Full REST API contract for trigger, get result, and list endpoints
  - 3 ADRs: pattern library approach, PII masking in stored findings, scan result storage contract
- `packages/shared-types/src/sdi.ts` — Typed interfaces and constants exported for backend and frontend consumption

**Key decisions:**
- Inline regex patterns chosen over NLP/ML models: deterministic, auditable, no data leaves deployment boundary (ADR-SDI-001).
- Raw matched strings never stored, logged, or returned via API — match counts only (ADR-SDI-002).
- Findings persisted at per-dimension grain (backupPointId × fileType × dataElementType); per-file hits are in-memory only (ADR-SDI-003).
- HIPAA excluded: no health/medical identifier patterns in scope; including HIPAA without detection would be a false positive at regulation level.
- Luhn algorithm applied post-match for PAN candidates; entropy check for credential Pattern C; placeholder allowlist for emails and credentials.
- Binary files (.pdf, .docx) capped at 50 MB; extraction failures are non-blocking (SDI_EXTRACTION_WARN).

### Sprint 6 — Protected Object Inventory and Resilience Module (2026-04-30)
**Goal:** Implement the Protected Object Inventory sidebar within the Resilience Module.

**Architect:** software_architect

**Deliverables produced:**
- `docs/architecture/resilience-module-architecture.md` — Full Resilience Module architecture:
  - Sidebar item model: `SidebarItem` interface with `id`, `label`, `nodeType`, `defaultSelected`, `purgeProtected`, `icon` fields
  - Static sidebar registry: Projects (default), Workflows (purge-protected), Custom Fields (purge-protected)
  - Inventory grid column contract per T8 §3 for all three node types (universal columns + type-specific columns)
  - Platform-layer purge cascade exclusion boundary design (references existing `purgeCascade.js` enforcement)
  - Cascade iterator skip rule (manifest-build-time exclusion via `isPurgeCascadeExcluded`)
  - UI protection indicator contract: lock icon + tooltip on sidebar; `purgeProtectedBadge` static column on grid rows
  - `GET /api/v1/resilience/inventory` API contract
  - 4 ADRs covering static registry, type-level protection flag, service-layer enforcement primacy, and CustomFieldNode label mapping

**Key decisions:**
- Sidebar registry is static (3 items fixed by product scope); `defaultSelected` set exclusively on `JiraProjectNode`.
- `purgeProtected` is a type-level flag, not per-object — mirrors the `PURGE_EXCLUDED_NODE_TYPES` set in `purgeCascade.js`.
- Purge cascade boundary is authoritative at the service layer; UI lock badge is informational only (ADR-RES-003).
- `JiraCustomFieldNode` (UI label) maps to `JiraCustomFieldDefinitionNode` at the data layer; both plus `JiraCustomFieldContextNode` are excluded from purge cascades.
- `purgeProtectedBadge` column is static on every Workflow and Custom Field grid row — no per-row configurability.

## Conventions
- All architecture docs live in `docs/architecture/`.
- Sequence diagrams use Mermaid `sequenceDiagram` blocks.
- Data model field definitions include type, nullable flag, and constraint notes.
- API contracts follow: Method + Path, request shape, success response shape, error codes.
### Sprint 1 | 2026-04-30 | ✅ done | 28 SP
**Goal:** [Phase: Authentication and Connection]
Establish Atlassian OAuth 2.0 (3LO) integration for Jira Cloud, covering both Express and Manual connection paths, cloudId resolution, 20-scope permission validation, multi-site selection, graceful degradation when Jira Software board scope is absent, refresh token expiry alerting, and integration lifecycle (Soft Delete / Hard Delete) setup.

Deliverables:
- Express OAuth path: authorization redirect to auth.atlassian.com with all required parameters, callback handler, cloudId resolution from accessible-resources
- Manual OAuth path: Client ID + Client Secret + Site URL + Redirect URI confirmation flow
- 20-scope permission validation at connect time with per-scope remediation messaging
- Multi-site dropdown when accessible-resources returns >1 site; auto-select when exactly 1 site returned
- Non-blocking banner and scope exclusion logic when read:board-scope:jira-software fails
- Project scope configuration: All Projects default, Selected Projects multi-select, Include Archived Projects toggle
- Refresh token expiry: 401 banner and 10-day advance proactive alert at 80-day inactivity threshold
- Integration deletion mode: Soft Delete (30-day retention default) and Hard Delete (sandbox-only) lifecycle configuration

**Delivered:**
- ✅ Design OAuth 2.0 3LO integration architecture and scope matrix — Software Architect (◉ Deep, 5 SP)
- ✅ Implement OAuth backend: Express path, Manual path, cloudId resolution, scope validation, and lifecycle endpoints — Backend Developer (◉ Deep, 8 SP)
- ✅ Implement OAuth connection UI: Express/Manual flows, site selector, scope validation display, and lifecycle controls — Frontend Developer (◉ Deep, 8 SP)
- ✅ Write environment and secrets configuration for OAuth service — Devops Engineer (⚡ Quick, 2 SP)
- ✅ QA: end-to-end test suite for OAuth paths, scope validation, multi-site, degradation, and lifecycle — Qa Engineer (◉ Deep, 5 SP)

---
### Sprint 2 | 2026-04-30 | ✅ done | 23 SP
**Goal:** [Phase: Backup Discovery and Data Ingestion]
Implement the full Jira object discovery and backup pipeline: full JQL enumeration on first run and incremental JQL cursor on subsequent runs, dynamic webhook registration for real-time deltas, attachment binary materialisation with deduplication, site-level shared object enumeration (Workflows, Custom Field Definitions and Contexts), and backup policy configuration (SLA Domain, RPO, retention, archive scope attributes, Data Scope refresh).

Deliverables:
- Full JQL enumeration (GET /search?project={key} ORDER BY updated ASC) on first backup run per project
- Incremental JQL cursor (updated >= lastBackupTimestamp ORDER BY updated ASC) on subsequent runs
- Dynamic webhook registration via manage:jira-webhook for issue_created, issue_updated, issue_deleted events
- Attachment binary download (GET /rest/api/3/attachment/content/{id}) for new attachment IDs; sidecar-only carry-forward for unchanged IDs
- Site-level enumeration of JiraWorkflowNode (GET /rest/api/3/workflow/search) and JiraCustomFieldDefinitionNode (GET /rest/api/3/field) on every backup run
- JiraCustomFieldContextNode enumeration per field via GET /rest/api/3/field/{fieldId}/context and /context/option
- Default SLA Domain (RPO=24h, retention=365d), Configuration A policy model, Secondary/Archive Copy capabilities
- Archive scope attributes: archived=true on JiraProjectNode, statusCategory=Done on JiraIssueNode, state=closed on JiraSprintNode
- Data Scope refresh interval default (24h) and manual Sync Now trigger
- Purge cascade boundary enforcement: JiraWorkflowNode, JiraCustomFieldDefinitionNode, JiraCustomFieldContextNode excluded from purge cascade at platform layer

**Delivered:**
- ✅ Design backup discovery pipeline architecture — Software Architect (◈ Standard, 3 SP)
- ✅ Define backup policy configuration schema and constants — Backend Developer (⚡ Quick, 2 SP)
- ✅ Implement JQL enumeration, incremental cursor, webhook registration, and attachment materialisation backend — Backend Developer (◉ Deep, 13 SP)
- ✅ QA: end-to-end and unit test suite for backup discovery pipeline — Qa Engineer (◉ Deep, 5 SP)

---
### Sprint 3 | 2026-04-30 | ✅ done | 26 SP
**Goal:** [Phase: Browse, Search, and Object Explorer]
Deliver the backup browse and search capabilities across all protected Jira object types: global search, project inventory search, issue search with structured filter panel, attachment search, Board and Sprint search, Object Explorer with change indicators (Added, Modified, Deleted), and unchanged-objects hide/show toggle.

Deliverables:
- Global search across JiraProjectNode, JiraWorkflowNode, JiraCustomFieldNode by name and key across all connected Jira sites
- Project inventory search: tokenised keyword on name, prefix/exact on key, filterable by projectTypeKey and archived boolean
- Issue search within a backup point: tokenised keyword on summary and key; structured filter panel for issuetype, status, statusCategory, priority, assignee, reporter, labels, created, updated, resolved, projectKey
- Attachment search: tokenised/prefix search on filename, filterable by mimeType and created date range
- Board and Sprint search: tokenised search on name, filterable by sprint state and date range
- Object Explorer: Added/Modified/Deleted change indicators per object with visual treatment
- Unchanged objects hidden by default; platform-level toggle to show all objects

**Delivered:**
- ✅ Design browse, search, and Object Explorer architecture — Software Architect (◈ Standard, 3 SP)
- ✅ Define search query schemas and change-indicator constants — Backend Developer (⚡ Quick, 2 SP)
- ✅ Implement search API endpoints and Object Explorer diff computation backend — Backend Developer (◉ Deep, 8 SP)
- ✅ Implement browse, search UI and Object Explorer frontend — Frontend Developer (◉ Deep, 8 SP)
- ✅ QA: end-to-end test suite for browse, search, and Object Explorer — Qa Engineer (◉ Deep, 5 SP)

---
### Sprint 4 | 2026-04-30 | ✅ done | 25 SP
**Goal:** [Phase: Restore Engine]
Implement the full point-in-time restore pipeline: dependency-ordered restore sequence, three conflict modes (Skip, Override, Ask), three restore destinations (original location, alternate/cross-site location, JSON+ZIP export), pre-execution validation checks, cross-site custom field ID mapping, and all permanent API constraint handling (issue key labelling, reporter attribution header, comment author ADF header, full workflow definition supply).

Deliverables:
- Dependency-ordered restore sequence: (1) Workflows + CustomFieldDefinitions, (2) Projects, (3) Parent Issues, (4) Comments + Attachments + Boards, (5) Sprints
- Conflict modes: Skip (default), Override, Ask per conflict; Ask hidden for baskets >50 items; Merge permanently excluded
- Restore destinations: original location (matched by project key/object name), alternate location (same-site or cross-site), JSON export + attachment binary ZIP download
- Cross-site custom field ID mapping step enforced for cross-site restores
- Pre-execution validation: OAuth token validity, target project existence and archive status, Jira Software active check, workflow status name check (non-blocking), custom field presence check (blocking for required, non-blocking for optional), attachment size ≤250 MB check
- Issue key labelling: original key stamped as label original-key:PROJ-123 on restore
- Reporter attribution preserved as header line in restored comment body
- Comment author original attribution prepended as inline ADF header in restored comment
- Full workflow definition supplied in full to workflow create/update API (no property-level restore)

**Delivered:**
- ✅ Design restore engine architecture and API contract — Software Architect (◉ Deep, 5 SP)
- ✅ Define restore pipeline constants, schemas, and conflict-mode configuration — Backend Developer (⚡ Quick, 2 SP)
- ✅ Implement restore engine backend: pipeline, validation, conflict modes, destinations, and API constraint handlers — Backend Developer (◉ Deep, 13 SP)
- ✅ QA: end-to-end and unit test suite for restore engine pipeline — Qa Engineer (◉ Deep, 5 SP)

---
### Sprint 5 | 2026-04-30 | ✅ done | 18 SP
**Goal:** [Phase: Sensitive Data Intelligence (SDI) Teaser]
Deliver the SDI teaser module that scans backed-up Jira data for four sensitive data element types (Email Address, Credential/API Key, Credit Card Number/PAN, Phone Number) across the defined file type set, and surfaces applicable regulations (GDPR, CCPA, PCI DSS as Active; DORA, NIS2, SOC 2 as Shown). HIPAA excluded.

Deliverables:
- SDI scan pipeline targeting backed-up Jira JSON and attachment content across: .json, .xml, .csv, .tsv, .pdf, .docx, .txt, .md, .yaml, .yml, .env, .properties, .toml
- Detection of four data element types: Email Address, Credential/API Key, Credit Card Number (PAN), Phone Number
- Regulation surface: GDPR, CCPA, PCI DSS displayed as Active; DORA, NIS2, SOC 2 displayed as Shown; HIPAA excluded
- SDI teaser results UI surfacing findings per backup point with data element type and file type breakdown

**Delivered:**
- ✅ Design SDI scan pipeline architecture and detection schemas — Software Architect (◈ Standard, 3 SP)
- ✅ Define SDI constants, regulation config, and detection pattern registry — Backend Developer (⚡ Quick, 2 SP)
- ✅ Implement SDI scan pipeline backend: extractors, pattern scanner, findings API — Backend Developer (◉ Deep, 8 SP)
- ✅ Implement SDI teaser results UI: findings surface per backup point — Frontend Developer (◉ Deep, 5 SP)

---
### Sprint 6 | 2026-05-01 | ✅ done | 18 SP
**Goal:** [Phase: Protected Object Inventory and Resilience Module]
Implement the Protected Object Inventory sidebar within the Resilience Module, surfacing JiraProjectNode (default), JiraWorkflowNode, and JiraCustomFieldNode with the standard column set defined in T8 §3, and enforcing the purge cascade exclusion boundary at the platform layer for workflow and custom field node types.

Deliverables:
- Resilience Module sidebar with three object type items: Projects (JiraProjectNode, default selected), Workflows (JiraWorkflowNode), Custom Fields (JiraCustomFieldNode)
- Default column set per T8 §3 rendered for each object type in the inventory grid
- Platform-layer purge cascade boundary: JiraWorkflowNode, JiraCustomFieldDefinitionNode, and JiraCustomFieldContextNode excluded from any purge cascade operation regardless of basket composition
- UI indication that workflow and custom field objects are protected from purge cascade

**Delivered:**
- ✅ Design Resilience Module sidebar and purge cascade boundary architecture — Software Architect (◈ Standard, 3 SP)
- ✅ Define Resilience Module constants, column schemas, and purge exclusion registry — Backend Developer (⚡ Quick, 2 SP)
- ✅ Implement platform-layer purge cascade boundary enforcement and inventory data API — Backend Developer (◉ Deep, 5 SP)
- ✅ Implement Resilience Module sidebar and inventory grid UI — Frontend Developer (◉ Deep, 5 SP)
- ✅ QA: Resilience Module sidebar, inventory grid, and purge cascade boundary — Qa Engineer (◈ Standard, 3 SP)

---
### Sprint 7 | 2026-05-01 | ✅ done | 18 SP
**Goal:** * Make sure the end product can be deployed locally on any mac, linux or windows system
* Create official documentation for the project - README, DEMO, Installation guide, user guide.

**Delivered:**
- ✅ Define cross-platform environment config and deployment constants — Devops Engineer (⚡ Quick, 2 SP)
- ✅ Implement cross-platform local deployment setup (Docker Compose + startup scripts) — Devops Engineer (◉ Deep, 8 SP)
- ✅ Write README, Installation Guide, and User Guide — Software Architect (◉ Deep, 5 SP)
- ✅ Produce DEMO script and record demo assets — Frontend Developer (◈ Standard, 3 SP)

---
### Sprint 8 | 2026-05-01 | ✅ done | 13 SP
**Goal:** * Replace docker with podman
* Add a user-facing architectural document that would explain how it everything works.

**Delivered:**
- ✅ Define Podman migration constants and compose config — Devops Engineer (⚡ Quick, 2 SP)
- ✅ Implement cross-platform Podman deployment and replace Docker runtime — Devops Engineer (◉ Deep, 5 SP)
- ✅ Write user-facing architectural overview document — Software Architect (◈ Standard, 3 SP)
- ✅ QA: validate Podman deployment and architectural doc accuracy — Qa Engineer (◈ Standard, 3 SP)

---
### Sprint 9 | 2026-05-01 | ✅ done | 13 SP
**Goal:** A couple of problems on the way, let's fix them
* If the callback URL is not https, I will get an error when I click on connect to Atlassian - Redirect URI must be a valid HTTPS URL
* We need better onboarding docuemntation in relation wtih the above

**Delivered:**
- ✅ Diagnose and document HTTPS callback URL constraint for local dev — Software Architect (⚡ Quick, 2 SP)
- ✅ Implement HTTPS callback URL support for local development environment — Devops Engineer (◉ Deep, 5 SP)
- ✅ Update onboarding documentation to cover HTTPS callback URL setup — Software Architect (◈ Standard, 3 SP)
- ✅ QA: validate HTTPS OAuth flow and documentation accuracy — Qa Engineer (◈ Standard, 3 SP)

---
### Sprint 10 | 2026-05-01 | ✅ done | 10 SP
**Goal:** We have a problem to resolve. Now I am 1 step ahead, I can go and try to authorize the app, and using caddy, I am getting the following when I authroise the app: 

The following in the browser URL bar: 
https://localhost:4443/oauth/callback?state=c733738d-e03f-43c1-b136-589da59bcda1&code=eyJraWQiOiJBVVRIX0NPREUtZTRlN2QwZjktNmMzNS00ZTE3LWI4NzQtODdjYTIwYWVkODNjIiwiYWxnIjoiSFMyNTYifQ.eyJqdGkiOiIzM2IzYzE0ZC1kNjQ5LTQyOWEtOTUxNC1mMDNkYTMwZDRlZTEiLCJzdWIiOiI3MTIwMjA6NDg1ODc2YzItOGZlZC00YWYyLWFjNjAtNGYwN2RkNDE0ODUyIiwibmJmIjoxNzc3NjI0OTQyLCJpc3MiOiJhdXRoLmF0bGFzc2lhbi5jb20iLCJpYXQiOjE3Nzc2MjQ5NDIsImV4cCI6MTc3NzYyNTI0MiwiYXVkIjoiMWhDTUlOS2l1R0RPeVd1R2tJNEJuTVFocThtd1BFYTkiLCJjbGllbnRfYXV0aF90eXBlIjoiTk9ORSIsImh0dHBzOi8vaWQuYXRsYXNzaWFuLmNvbS9wa2NlIjoianNmODNyTmpsemlQclhZTVV0WVRNTkhwMlVEOHlmVmd0cTFxU3NxT28zQmQwMGRkR3laY01MS3duRjNRMlU1U0hFMlpJZzB1WGRQZC92WjhBZXh4NlJDRnZqZE96dTRWQ3BBQnY0b29lN3hOUGNBaG9xWEx0SHJJeW41Sk5HdXJiK3hxQTBjUUVOd2JyZEVPRGdGR2dYdDJwN2xTQnZWa3NtY0lkcGlUdHNVMWZycStyblgwVE9UYzQwakdEc1JWNHVFako1ZE1BVlYyLy9MZ1htd041ZHM5T0pqZUQ4V3AiLCJyZWRpcmVjdFVyaSI6Imh0dHBzOi8vbG9jYWxob3N0OjQ0NDMvb2F1dGgvY2FsbGJhY2siLCJodHRwczovL2lkLmF0bGFzc2lhbi5jb20vaXYiOiJNZkFiK3BlSFVXYnYvUi9yIiwiaHR0cHM6Ly9pZC5hdGxhc3NpYW4uY29tL3ZlcmlmaWVkIjp0cnVlLCJodHRwczovL2lkLmF0bGFzc2lhbi5jb20vdWp0IjoiMzNiM2MxNGQtZDY0OS00MjlhLTk1MTQtZjAzZGEzMGQ0ZWUxIiwic2NvcGUiOlsibWFuYWdlOmppcmEtcHJvamVjdCIsIndyaXRlOmVwaWM6amlyYS1zb2Z0d2FyZSIsInJlYWQ6amlyYS13b3JrIiwicmVhZDpwcm9qZWN0OmppcmEiLCJyZWFkOmppcmEtdXNlciIsIndyaXRlOmlzc3VlOmppcmEiLCJtYW5hZ2U6amlyYS1jb25maWd1cmF0aW9uIiwicmVhZDp1c2VyOmppcmEiLCJyZWFkOmVwaWM6amlyYS1zb2Z0d2FyZSIsInJlYWQ6ZmllbGQ6amlyYSIsInJlYWQ6c3ByaW50OmppcmEtc29mdHdhcmUiLCJvZmZsaW5lX2FjY2VzcyIsInJlYWQ6aXNzdWUtdHlwZTpqaXJhIiwibWFuYWdlOmppcmEtd2ViaG9vayIsInJlYWQ6aXNzdWU6amlyYSIsIndyaXRlOmppcmEtd29yayIsIndyaXRlOnNwcmludDpqaXJhLXNvZnR3YXJlIiwid3JpdGU6cHJvamVjdDpqaXJhIiwid3JpdGU6ZmllbGQ6amlyYSIsInJlYWQ6Ym9hcmQtc2NvcGU6amlyYS1zb2Z0d2FyZSJdLCJodHRwczovL2lkLmF0bGFzc2lhbi5jb20vYXRsX3Rva2VuX3R5cGUiOiJBVVRIX0NPREUiLCJodHRwczovL2lkLmF0bGFzc2lhbi5jb20vaGFzUmVkaXJlY3RVcmkiOnRydWUsImh0dHBzOi8vaWQuYXRsYXNzaWFuLmNvbS9zZXNzaW9uX2lkIjoiYjhkN2JiMmEtZmNlYS00NTJhLWI0ZjctZWNjNWI3MjU5NmIzIiwiaHR0cHM6Ly9pZC5hdGxhc3NpYW4uY29tL3Byb2Nlc3NSZWdpb24iOiJ1cy1lYXN0LTEifQ._TcVNcuKouVSn9K7wxs_JJ7YCOuN3cHJAW_n_7UovyM

And then this in in the page: 
{"error":"NOT_FOUND","message":"Route GET /oauth/callback not found"}

**Delivered:**
- ✅ Diagnose OAuth callback 404 and define fix strategy — Software Architect (⚡ Quick, 2 SP)
- ✅ Implement and wire GET /oauth/callback route in the backend — Backend Developer (◉ Deep, 5 SP)
- ✅ QA: validate full OAuth 3LO callback flow end-to-end — Qa Engineer (◈ Standard, 3 SP)

---
### Sprint 11 | 2026-05-01 | ✅ done | 13 SP
**Goal:** Issues: 
1. When I try to run: t.hadzhiev@vsap-mac-CT4J57WCR2 jira_workload % podman-compose logs -f app          
Jira Workload backend listening on port 4000
 I don't see any logs: 

2. podman-compose -f podman-compose.yml logs -f.  <- this doesn't work it fails with: 
podman-compose -f podman-compose.yml logs -f

3. As suggested in the DEMO.md  when I open the http://localhost:4000/manage.html

I get this: ✖
Failed to load integration
No connectionId found in the URL. Navigate here from the connection wizard.

even though before that the integration was reported to be successful. 

4. Maybe try to use in integration tests the following for express. Here are the values in my env: 

ATLASSIAN_CLIENT_ID=1hCMINKiuGDOyWuGkI4BnMQhq8mwPEa9
ATLASSIAN_CLIENT_SECRET=ATOA2Aa0QE5e0OjgSP02EfWRuJBgpg3HyHX-CsGAKk3YuUIeJC0j4ct3YAPCszr9-7_b6A3016F0
ATLASSIAN_REDIRECT_URI=https://localhost:4443/oauth/callback
OAUTH_TOKEN_ENCRYPTION_KEY=0ae79904e41359173d04fe7a63a93c289db8b411b9467cbc87e4d0646e4c133d

**Delivered:**
- ✅ Diagnose and fix podman-compose log streaming and -f flag issues — Devops Engineer (◈ Standard, 3 SP)
- ✅ Fix manage.html 'No connectionId in URL' error after successful OAuth flow — Backend Developer (◉ Deep, 5 SP)
- ✅ Add integration tests for OAuth callback and manage API using real env credentials — Qa Engineer (◉ Deep, 5 SP)

---
