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
