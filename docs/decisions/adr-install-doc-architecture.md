# ADR — Installation Documentation Architecture

**Status:** Accepted  
**Date:** 2026-05-01  
**Author:** Software Architect  
**Sprint:** 13 (Doc optimisation)

---

## Context

Sprint 12 introduced an installation package / versioned-release flow. As a result
the project now has multiple overlapping installation documents. The user also
reported two concrete issues that are blocked by the current state:

1. `git pull` fails with a dirty working-tree error when `podman-compose.yml` has
   been locally modified (e.g. the Caddy sidecar was uncommented).
2. There are no complete instructions for installing from a container registry —
   only a stub with a placeholder registry URL.

---

## Existing Document Inventory

| File | Location | Content summary | Problem |
|---|---|---|---|
| `README.md` | root | Quick-start (git clone), upgrade snippet, OAuth setup, dev section, links to other docs | Good entry point but duplicates OAuth content from `docs/INSTALLATION.md`; upgrade section is a thin summary |
| `readme.md` | root | **Exact duplicate** of `README.md` | Should be removed (case-sensitivity artifact) |
| `INSTALL.md` | root | Clone-based install, upgrade guide, pre-built-image stub, data-persistence detail, troubleshooting | Ends with "See `docs/INSTALLATION.md` for HTTPS callback URL setup" — forward-reference loop; pre-built-image section uses placeholder registry URL with no real compose download workflow |
| `docs/INSTALLATION.md` | docs/ | Platform install (Podman + Node.js), OAuth setup (ngrok/Caddy), upgrade section, troubleshooting | Ends with "See **INSTALL.md** for full upgrade guide and pre-built image" — back-reference loop with root `INSTALL.md`; OAuth setup duplicates large portions of `README.md` and `OAUTH_SETUP.md` |
| `OAUTH_SETUP.md` | root | Full OAuth 2.0 3LO registration, HTTPS workaround (ngrok + Caddy), scope list | Standalone reference; good canonical source for OAuth content |
| `docs/ARCHITECTURE.md` | docs/ | User-facing architecture overview | Not an install doc; no changes needed |
| `docs/USER_GUIDE.md` | docs/ | Feature usage | Not an install doc; no changes needed |
| `docs/DEMO.md` | docs/ | Demo walkthrough | Not an install doc; no changes needed |

### Content gaps identified

| Gap | Affected files |
|---|---|
| No complete container-registry install path (only a stub placeholder) | `INSTALL.md` |
| No `podman-compose.override.yml` pattern documented to protect local changes from `git pull` | `INSTALL.md`, `docs/INSTALLATION.md`, `README.md` |
| Git pull dirty-tree problem not documented or mitigated | All install docs |
| Upgrade instructions exist in three places with slight variations | `README.md`, `INSTALL.md`, `docs/INSTALLATION.md` |
| OAuth setup content duplicated across `README.md`, `docs/INSTALLATION.md`, `OAUTH_SETUP.md` | All three |
| No full container compose file available for download (only inline YAML stub) | `INSTALL.md` |
| `readme.md` duplicate file at root | — |

---

## Decision

### Canonical documentation set (post-refactor)

| File | Scope | Replaces |
|---|---|---|
| `README.md` | Project overview + quick-orientation links only. Points to both install methods. Does **not** duplicate content from either install doc. | Existing `README.md` (trimmed) |
| `INSTALL-GIT.md` | **Method 1 — Git clone / development workflow.** Full authoritative guide for anyone who clones the repo (dev, contributor, self-hoster who wants to build locally). Covers: prerequisites, clone + configure, start/stop scripts, the `podman-compose.override.yml` pattern for local customisation, upgrade procedure, data backup, troubleshooting. | `INSTALL.md` (root) + install sections of `docs/INSTALLATION.md` |
| `INSTALL-CONTAINER.md` | **Method 2 — Container registry install.** Full authoritative guide for anyone who wants to run the app without cloning source code. Covers: prerequisites, pulling the image from the registry, standalone `podman-compose.yml` (downloadable), `.env` configuration, start/stop, upgrade (pull new image tag), data backup, troubleshooting. | The stub "Using a Pre-built Image" section in `INSTALL.md` |
| `OAUTH_SETUP.md` | OAuth 2.0 3LO registration, HTTPS workaround (ngrok/Caddy), scope list. **Unchanged** — remains the single canonical OAuth reference. Both install docs link here for OAuth detail. | No change |
| `docs/INSTALLATION.md` | **To be removed** (content merged into `INSTALL-GIT.md`). Platform-specific notes that are still relevant will be carried over. | — |
| `INSTALL.md` | **To be removed** (replaced by `INSTALL-GIT.md` and `INSTALL-CONTAINER.md`). | — |
| `readme.md` | **To be removed** (case-insensitive duplicate of `README.md`). | — |

---

## README.md Structure (post-refactor)

```
# jira_workload
[badges]

## What is this?
[feature table — unchanged]

## Choose your installation method
| Method | When to use | Guide |
|---|---|---|
| Git clone (recommended for developers) | You want to build from source, contribute, or customise | [INSTALL-GIT.md](INSTALL-GIT.md) |
| Container registry (recommended for end users) | You want to run the app without a source checkout | [INSTALL-CONTAINER.md](INSTALL-CONTAINER.md) |

## Quick start (git / dev)
[3-step clone → configure → start.sh summary, links to INSTALL-GIT.md for full detail]

## Quick start (container)
[3-step pull → configure → podman-compose up summary, links to INSTALL-CONTAINER.md for full detail]

## OAuth setup
[1-paragraph summary + link to OAUTH_SETUP.md — no duplication]

## Architecture
[Link to docs/ARCHITECTURE.md]

## Documentation
[Links table]

## Development
[npm install / npm run dev / npm test]
```

---

## Known Issue: git pull fails with dirty working tree (to be fixed in task-002)

**Root cause:** `podman-compose.yml` is committed to the repository. Users who
customise it locally (e.g. uncommenting the Caddy sidecar, changing port mappings,
or adding environment variables) accumulate uncommitted local changes. When `git pull`
is run, Git refuses to merge if any tracked file has local modifications:

```
error: Your local changes to the following files would be overwritten by merge:
    podman-compose.yml
Please commit your changes or stash them before you merge.
Aborting
```

**Solution (to be implemented in task-002 / INSTALL-GIT.md):**

Use the `podman-compose.override.yml` file pattern — the same override mechanism
supported by Docker Compose and podman-compose. The base `podman-compose.yml` stays
pristine (never locally modified) and all user-specific overrides live in
`podman-compose.override.yml`, which is git-ignored.

Steps to document in `INSTALL-GIT.md`:
1. Add `podman-compose.override.yml` to `.gitignore`.
2. Instruct users: if you want to customise the compose stack (Caddy, custom ports,
   extra environment variables), do it in `podman-compose.override.yml`, not in
   `podman-compose.yml`.
3. Update `start.sh` / `start.ps1` / `start.bat` to pass
   `-f podman-compose.yml -f podman-compose.override.yml` when the override file exists.
4. Include an `podman-compose.override.yml.example` in the repo showing the Caddy
   sidecar addition as an example override.

This fully resolves the dirty-tree `git pull` problem without requiring users to
stash or commit their local compose customisations.

---

## Consequences

- `INSTALL.md` and `docs/INSTALLATION.md` are removed (their content is consolidated).
- `readme.md` (duplicate) is removed.
- Every place in the codebase that links to `INSTALL.md` or `docs/INSTALLATION.md`
  must be updated to point to `INSTALL-GIT.md` or `INSTALL-CONTAINER.md` as appropriate.
- `podman-compose.override.yml` is added to `.gitignore`.
- `README.md` is restructured to be a short navigation hub (no more duplicated install
  or OAuth content).
