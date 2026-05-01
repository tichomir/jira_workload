# How jira_workload Works — Architecture Overview

This document explains how jira_workload is built and how its pieces fit together.
It is written for technical evaluators, IT administrators, and users who want to
understand what the software actually does before deploying it.

No prior knowledge of the codebase is assumed. Internal acronyms are explained
on first use.

---

## Table of Contents

1. [What does jira_workload do?](#1-what-does-jira_workload-do)
2. [Major components](#2-major-components)
3. [End-to-end data flow](#3-end-to-end-data-flow)
   - [Backup path](#backup-path-jira-cloud--your-machine)
   - [Restore path](#restore-path-your-machine--jira-cloud)
4. [Key concepts](#4-key-concepts)
   - [Backup points](#backup-points)
   - [Conflict modes](#conflict-modes)
   - [Purge cascade boundary](#purge-cascade-boundary)
   - [Protected object types](#protected-object-types)
5. [Deployment topology — what runs where](#5-deployment-topology--what-runs-where)
6. [Security model](#6-security-model)

---

## 1. What does jira_workload do?

jira_workload is a **self-hosted backup and recovery platform for Jira Cloud**.
You run it on your own machine (or server). It connects to your Jira Cloud site,
copies your Jira data onto your local storage, and lets you browse, search, and
restore that data whenever you need it.

Core capabilities at a glance:

| Capability | What it gives you |
|---|---|
| **Backup** | A complete, versioned snapshot of your Jira projects, issues, workflows, custom fields, and attachments |
| **Browse & Search** | Browse any snapshot by project or issue; search across all snapshots; see exactly what changed between snapshots |
| **Point-in-time Restore** | Restore individual issues, whole projects, workflows, or custom fields to any earlier snapshot |
| **Sensitive Data Intelligence (SDI)** | Scan backup data for accidentally stored secrets (API keys, credit card numbers, email addresses, phone numbers) and see which data-protection regulations apply |
| **Resilience Module** | Inventory of objects that are permanently protected from accidental deletion within the platform |

Nothing leaves your machine except the outbound API calls to Jira Cloud that are
needed to fetch and push data.

---

## 2. Major components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Your web browser                                     │
│  connect · manage · browse · SDI results · resilience inventory · …        │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │  HTTP on port 4000
┌──────────────────────────────▼──────────────────────────────────────────────┐
│                  Express web server  (runs inside Podman container)         │
│                                                                             │
│  ┌─────────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │  OAuth module   │  │ Backup engine│  │Restore engine│  │  SDI scanner│ │
│  │  (connect +     │  │ (JQL enum,   │  │ (dep-ordered │  │  (regex +   │ │
│  │   token mgmt)   │  │  webhooks,   │  │  pipeline,   │  │   Luhn +    │ │
│  │                 │  │  attachments)│  │  3 conflict  │  │  entropy)   │ │
│  └────────┬────────┘  └──────┬───────┘  │  modes)      │  └──────┬──────┘ │
│           │                  │          └──────┬───────┘         │        │
│  ┌────────▼──────────────────▼─────────────────▼─────────────────▼──────┐  │
│  │                   In-memory data store + local volumes               │  │
│  │  OAuthConnections · CloudSites · BackupPoints · RestoreJobs ·        │  │
│  │  SdiScanResults   data/backups/ · data/sdi-tmp/ · data/exports/      │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │              Resilience Module  (purge cascade boundary)             │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │  HTTPS to api.atlassian.com
┌──────────────────────────────▼──────────────────────────────────────────────┐
│                          Jira Cloud  (Atlassian)                            │
│  OAuth token endpoint · REST API v3 · Agile API · Webhooks                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### OAuth module
Handles the initial handshake with Atlassian. When you click "Connect", it sends
you through the standard OAuth 2.0 authorization flow. After you approve access,
Atlassian returns tokens that are immediately encrypted and stored locally — they
are never sent back to your browser or logged.

### Backup engine
Fetches your Jira data on a schedule or on demand:
- **First run:** downloads every issue in every configured project using JQL (Jira
  Query Language), plus workflows, custom field definitions, and attachment files.
- **Subsequent runs:** only fetches items updated since the last backup, keeping
  bandwidth and runtime low.
- **Real-time deltas:** optionally registers Atlassian webhooks so that issue
  creates, updates, and deletes are pushed to the platform immediately.

### Restore engine
Replays backed-up data back to Jira Cloud in a safe, dependency-ordered sequence.
Before writing anything, it validates OAuth token health, checks whether target
projects exist, and flags potential conflicts for your review.

### SDI scanner (Sensitive Data Intelligence)
Scans the contents of backed-up files — JSON exports, CSVs, PDFs, Word documents,
and more — looking for patterns that match sensitive data types. Results show
counts only; raw matching text is never stored.

### Resilience Module
Provides a read-only inventory of objects that are always shielded from the
platform's internal "purge cascade" operation (bulk deletion of backup data).
Workflows and Custom Fields are always protected; Projects can be included in a
purge if you choose.

---

## 3. End-to-end data flow

### Backup path: Jira Cloud → your machine

```
  Your machine (Podman container)          Atlassian cloud
  ─────────────────────────────────        ──────────────────────────

  1. User clicks "Run backup now"
     POST /api/v1/backup/trigger
            │
            ▼
  2. Backup engine reads stored
     OAuth tokens (decrypted from           ──────────────────────────────┐
     local encrypted store)                                               │
            │                                                             │
            ▼                                                             ▼
  3. JQL query sent                    →   Jira Cloud: GET /rest/api/3/search
     (first run: all issues)               Returns: paginated issue list
     (later runs: updated >= lastTs)  ←
            │
            ▼
  4. For each new attachment ID       →   Jira Cloud: GET /attachment/content/{id}
     Download binary file             ←   Returns: raw file bytes
            │
            ▼
  5. Site-level objects fetched       →   Jira Cloud: GET /rest/api/3/workflow/search
     (workflows, custom fields)            GET /rest/api/3/field + /context
                                      ←   Returns: workflow and field definitions
            │
            ▼
  6. BackupPoint snapshot created
     ┌──────────────────────────────┐
     │  data/backups/               │
     │    {backupPointId}/          │
     │      issues.json             │
     │      workflows.json          │
     │      customFields.json       │
     │      attachments/            │
     │        {attachmentId}.bin    │
     └──────────────────────────────┘
            │
            ▼
  7. API responds: { backupPointId, itemCount }
     Browser updates backup history list
```

Unchanged attachments from the previous backup are referenced by sidecar pointer
rather than downloaded again, saving storage and time.

---

### Restore path: your machine → Jira Cloud

```
  Your machine (Podman container)          Atlassian cloud
  ─────────────────────────────────        ──────────────────────────

  1. User selects a backup point and
     objects to restore, chooses conflict
     mode, clicks "Restore"
     POST /api/v1/restore/start
            │
            ▼
  2. Pre-execution validation
     ✔ OAuth token valid?
     ✔ Target project exists + not archived?
     ✔ Custom field IDs present at destination?
     ✔ Attachments ≤ 250 MB?
            │  (blocking issues abort; warnings continue)
            ▼
  3. Restore pipeline — dependency order:

     Stage 1: Workflows + Custom Field Definitions
     Stage 2: Projects
     Stage 3: Parent Issues
     Stage 4: Comments + Attachments + Boards
     Stage 5: Sprints

     For each object, apply conflict mode:    →   Jira Cloud REST API
       Skip:     skip if already exists       ←   Creates / updates objects
       Override: overwrite existing
       Ask:      prompt user (≤ 50 items)
            │
            ▼
  4. API constraint handlers applied
     • Issue keys stamped as label "original-key:PROJ-123"
       (Jira does not allow replaying arbitrary keys)
     • Reporter + comment author preserved as
       text headers in the restored content
       (Jira Cloud API does not allow setting
        author to arbitrary users)
            │
            ▼
  5. Restore job status returned
     Browser shows per-stage progress + any skipped/failed items
```

---

## 4. Key concepts

### Backup points

A **backup point** is a complete snapshot of your Jira data at a specific moment in
time. Each backup run produces one backup point, identified by a unique ID and a
timestamp.

- Backup points are stored in the `data/backups/` volume on your machine.
- You can browse the contents of any backup point independently of others.
- Point-in-time restore always targets a specific backup point — you choose which
  one you want to roll back to.
- Deleting a backup point permanently removes all associated data (issues, workflows,
  attachment files). Workflows and Custom Fields cannot be removed via the purge
  cascade (see below).

---

### Conflict modes

When restoring, some objects you want to restore may already exist in the target
Jira site. The **conflict mode** tells the restore engine what to do:

| Mode | What happens | When to use it |
|---|---|---|
| **Skip** (default) | If the object already exists, leave it alone and move on | Safe, non-destructive; good for "fill gaps" restores |
| **Override** | Overwrite the existing object with the backup version | Use when you want to roll back to an earlier state |
| **Ask** | Prompt you to decide for each conflicting object | Use for small, selective restores where you need fine control |

> **Note:** The Ask mode is automatically downgraded to Skip when more than 50
> objects are in the restore basket. This prevents the interface from becoming
> unusable for large restores.

A fourth mode — **Merge** — is permanently excluded from the platform. Deep-merging
complex Jira objects (issues with custom fields, sprints, attachments, comments)
risks silent data corruption and is not supported.

---

### Purge cascade boundary

The platform includes an operation called a **purge cascade** — a way to bulk-delete
backup data for one or more objects. For example, you might purge all backed-up data
for a project that no longer exists.

The **purge cascade boundary** is a hard rule that prevents certain object types from
ever being included in a purge cascade, regardless of what you select in the UI.
This is enforced in the server-side code (`src/services/purgeCascade.js`), not just
in the interface.

The boundary exists because Workflows and Custom Fields are shared across all
projects on a Jira site. Accidentally purging them would corrupt backup snapshots
for every project that references them.

---

### Protected object types

Three object types appear in the Resilience Module's Protected Object Inventory:

| Object type | Purge-protected | Why |
|---|---|---|
| **Projects** (`JiraProjectNode`) | No — can be purged | Projects are self-contained; purging one does not affect others |
| **Workflows** (`JiraWorkflowNode`) | **Yes — always protected** | Shared across all projects on the site |
| **Custom Fields** (`JiraCustomFieldNode`) | **Yes — always protected** | Shared across all projects on the site |

The lock icon shown next to Workflows and Custom Fields in the sidebar is informational.
The actual protection is enforced at the server layer and cannot be bypassed via the UI.

---

## 5. Deployment topology — what runs where

```
┌─────────────────────────────────────────────────────────────────────┐
│                  Your local machine (or server)                      │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Podman (rootless — no root daemon, no Docker socket needed) │   │
│  │                                                              │   │
│  │  ┌────────────────────────────────────────────────────────┐  │   │
│  │  │  Container: jira-workload:latest                       │  │   │
│  │  │  Base image: node:20-alpine                            │  │   │
│  │  │  Runs as:    non-root user (UID 1001)                  │  │   │
│  │  │  Port:       4000 (mapped to host)                     │  │   │
│  │  │                                                        │  │   │
│  │  │  Volumes (persisted across restarts):                  │  │   │
│  │  │    backup_data  → /app/data/backups                    │  │   │
│  │  │    sdi_tmp      → /app/data/sdi-tmp                    │  │   │
│  │  │    export_data  → /app/data/exports                    │  │   │
│  │  └────────────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Your browser  ──────────────────────►  http://localhost:4000        │
└──────────────────────────────────────────────────────────────────────┘
                        │  outbound HTTPS only
                        ▼
        ┌────────────────────────────────────┐
        │         Atlassian cloud            │
        │  auth.atlassian.com  (OAuth)       │
        │  api.atlassian.com   (Jira REST)   │
        └────────────────────────────────────┘
```

**What runs locally (inside Podman):**
- The Express web server and all API endpoints
- The backup engine, restore engine, SDI scanner, and resilience module
- All backup data, attachment files, and restore exports
- The in-memory data store (OAuth tokens, backup point metadata, scan results)

**What runs in Atlassian cloud:**
- Jira Cloud itself — your live projects, issues, workflows
- The OAuth 2.0 authorization server (`auth.atlassian.com`)
- Webhook delivery (Atlassian pushes events to your local server; this requires your
  server to be reachable from the internet for webhooks to work)

**Network summary:**
- All traffic from the platform to Atlassian is outbound HTTPS.
- Your browser talks only to `http://localhost:4000`.
- No data is sent anywhere other than Atlassian's own API endpoints.

### Podman vs Docker

This platform uses **Podman** instead of Docker. Podman is:
- **Rootless by default** — the container process does not require elevated privileges
  on the host machine.
- **Daemonless** — there is no background service that must run as root. The container
  is a regular process owned by your user account.
- **Compatible** — `podman-compose` understands the same `docker-compose.yml` format.

The startup scripts (`start.sh`, `start.ps1`, `start.bat`) handle platform differences
automatically: on macOS they start and validate the Podman virtual machine; on Linux
they export the correct socket path for rootless mode; on Windows they detect Podman
Desktop or fall back to WSL2.

---

## 6. Security model

| Concern | How it is handled |
|---|---|
| **OAuth token storage** | Tokens encrypted at rest with AES-256-GCM; key set via `OAUTH_TOKEN_ENCRYPTION_KEY` environment variable; never logged or returned to the browser |
| **Authorization code interception** | PKCE (`S256` challenge method) used on every OAuth flow |
| **Sensitive match data** | SDI scanner stores match counts only; raw matched strings (e.g. actual credit card numbers) are never written to disk or returned by the API |
| **Container privilege** | Container runs as a non-root user (UID 1001); Podman rootless mode means no host root involvement |
| **Scope degradation** | If the optional Jira Software board scope is not granted, board and sprint features are disabled with a non-blocking warning rather than failing the connection |
| **Refresh token expiry** | Platform alerts 10 days before the 90-day Atlassian inactivity threshold; shows a 401 banner if the token has already expired |

---

## Further reading

- [Installation Guide](INSTALLATION.md) — step-by-step setup for macOS, Linux, and Windows
- [User Guide](USER_GUIDE.md) — how to use every feature
- [OAuth Setup](../OAUTH_SETUP.md) — registering an Atlassian OAuth app
- [Architecture ADRs](architecture/) — detailed per-sprint architecture decision records
