# User Guide

## Overview

jira_workload provides a REST API backend plus a set of static HTML pages for
interacting with your Jira Cloud data. After completing the installation, access
the application at **http://localhost:4000**.

---

## Navigation

| Page | URL | Description |
|---|---|---|
| Connect | `/connect.html` | Set up an Atlassian OAuth connection |
| Manage | `/manage.html` | Manage existing connections |
| Browse | `/browse.html` | Browse and search backed-up Jira objects |
| SDI | `/sdi.html` | Sensitive Data Intelligence scan results |
| Resilience | `/resilience.html` | Protected Object Inventory |
| OAuth Callback | `/callback.html` | Handled automatically during OAuth flow |

---

## Module 1: OAuth Connection

### Connecting to Jira Cloud

1. Open **http://localhost:4000/connect.html**

![Connect Page — OAuth wizard](images/connect-page.png)

2. Choose a connection method:
   - **Express path**: Click "Connect with Atlassian" — you are redirected to
     Atlassian to authorise the application, then returned automatically.
   - **Manual path**: Enter your Client ID, Client Secret, Site URL, and
     Redirect URI directly.

![Express OAuth redirect to Atlassian](images/oauth-atlassian-redirect.png)

3. If your account has access to multiple Atlassian sites, a site selector
   dropdown appears — choose the site to connect.

![Multi-site selector dropdown](images/connect-site-selector.png)

4. If the `read:board-scope:jira-software` scope is not granted, a non-blocking
   banner appears. Board and Sprint data will be excluded; all other data types
   are still available.

![Board scope degradation banner](images/connect-board-scope-banner.png)

### Managing Connections

Open **http://localhost:4000/manage.html** to:

![Manage integrations page](images/manage-integrations.png)
- View the status of all connected integrations.
- Configure project scope (All Projects, or select specific projects).
- Delete an integration (Soft Delete by default — data retained for 30 days).

### Refresh Token Expiry Alerts

Atlassian invalidates refresh tokens after 90 days of inactivity.  
A proactive warning banner is shown 10 days before expiry (at 80 days).  
Re-authenticate via the Connect page to reset the timer.

---

## Module 2: Backup & Discovery

![Backup status on manage page](images/backup-status.png)

Backups run automatically after connecting. The API endpoints:

| Endpoint | Description |
|---|---|
| `POST /api/v1/integrations/:id/backup` | Trigger a manual backup |
| `GET  /api/v1/integrations/:id/backup-points` | List backup points |
| `GET  /api/v1/backup-points/:bpId` | Get backup point details |

**First run**: Full JQL enumeration across all selected projects.  
**Subsequent runs**: Incremental cursor (`updated >= lastBackupTimestamp`).

Webhooks (`issue_created`, `issue_updated`, `issue_deleted`) are registered
automatically for real-time delta capture between scheduled runs. These require
a publicly reachable `WEBHOOK_CALLBACK_URL` (use [ngrok](https://ngrok.com) for
local development).

---

## Module 3: Browse, Search, and Object Explorer

Open **http://localhost:4000/browse.html** for the browse interface.

![Browse page — backup point selector](images/browse-backup-points.png)

### Global Search

```
GET /api/v1/search/global?q=<term>
```

Searches across Projects, Workflows, and Custom Fields by name and key.

### Issue Search

```
GET /api/v1/search/issues?backupPointId=<id>&q=<term>&issuetype=Bug&status=Done
```

Full filter panel supports: `issuetype`, `status`, `statusCategory`, `priority`,
`assignee`, `reporter`, `labels`, `created`, `updated`, `resolved`, `projectKey`.

### Object Explorer

Navigate to any backup point to see objects with change indicators:
- **Added** — object is new since the previous backup point.
- **Modified** — object changed since the previous backup point.
- **Deleted** — object was removed.
- Unchanged objects are hidden by default; use the toggle to show all.

![Object Explorer with change indicators](images/object-explorer-changes.png)

---

## Module 4: Point-in-Time Restore

![Restore — select backup point and items](images/restore-item-selection.png)

```
POST /api/v1/restore
```

### Conflict Modes

![Restore — conflict mode selector](images/restore-conflict-mode.png)

| Mode | Behaviour |
|---|---|
| `skip` (default) | Skip objects that already exist at the target |
| `override` | Overwrite existing objects with backed-up versions |
| `ask` | Prompt for each conflict (suppressed to `skip` for baskets > 50 items) |

### Restore Destinations

![Restore — destination selector](images/restore-destination.png)

| Destination | Description |
|---|---|
| Original location | Restore to the same project / site |
| Alternate location | Restore to a different project or cross-site |
| JSON + ZIP export | Download a ZIP archive of restored data |

### Permanent API Constraints

These are applied automatically during restore and cannot be overridden:

- **Issue key**: Stamped as label `original-key:PROJ-123` on the restored issue.
- **Reporter**: Attribution preserved as a header line in the restored description.
- **Comment author**: Original author prepended as an ADF header in the comment body.
- **Workflows**: Full workflow JSON supplied to the Jira API (no partial patching).

### Cross-site Restore

When restoring to a different Jira Cloud site, custom field IDs are mapped
automatically. Missing required custom fields are a blocking gate; missing
optional fields are non-blocking.

---

## Module 5: Sensitive Data Intelligence (SDI)

Open **http://localhost:4000/sdi.html** for the SDI results interface.

![SDI dashboard — findings overview](images/sdi-dashboard.png)

### Triggering a Scan

```
POST /api/v1/sdi/scan
{ "backupPointId": "<id>" }
```

### Scan Coverage

**File types scanned**: `.json`, `.xml`, `.csv`, `.tsv`, `.pdf`, `.docx`,
`.txt`, `.md`, `.yaml`, `.yml`, `.env`, `.properties`, `.toml`

**Data element types detected**:

| Type | Detection method |
|---|---|
| Email Address | RFC-5321 regex |
| Credential / API Key | Entropy + pattern matching |
| Credit Card (PAN) | Luhn-validated regex |
| Phone Number | E.164 and local format regex |

### Regulations Surfaced

| Regulation | Display |
|---|---|
| GDPR | Active |
| CCPA | Active |
| PCI DSS | Active |
| DORA | Shown |
| NIS2 | Shown |
| SOC 2 | Shown |

**Note**: Raw matched strings are never stored or returned via API — only match
counts are persisted.

### Getting Scan Results

![SDI results — data element type breakdown](images/sdi-results-breakdown.png)

```
GET /api/v1/sdi/results?backupPointId=<id>
GET /api/v1/sdi/results          # list all
```

---

## Module 6: Resilience Module

Open **http://localhost:4000/resilience.html** for the inventory interface.

![Resilience Module — Protected Object Inventory sidebar](images/resilience-sidebar.png)

### Protected Object Inventory

The sidebar shows three object type categories:

![Resilience Module — inventory grid with purge-protected badge](images/resilience-inventory-grid.png)

| Item | Node Type | Purge Protected |
|---|---|---|
| Projects | `JiraProjectNode` | No (selected by default) |
| Workflows | `JiraWorkflowNode` | Yes |
| Custom Fields | `JiraCustomFieldNode` | Yes |

### API

```
GET /api/v1/resilience/inventory?nodeType=JiraWorkflowNode
```

### Purge Cascade Boundary

`JiraWorkflowNode`, `JiraCustomFieldDefinitionNode`, and
`JiraCustomFieldContextNode` are **permanently excluded** from any purge cascade
operation at the platform layer, regardless of basket composition.

Attempting to purge these types returns:
```json
{
  "error": "PURGE_CASCADE_FORBIDDEN",
  "nodeType": "JiraWorkflowNode"
}
```

---

## API Reference Summary

All endpoints are prefixed with `/api/v1/`.

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| POST | `/oauth/connect` | Initiate OAuth connection |
| GET | `/oauth/callback` | OAuth callback handler |
| GET | `/integrations` | List integrations |
| DELETE | `/integrations/:id` | Delete integration (soft/hard) |
| POST | `/integrations/:id/backup` | Trigger backup |
| GET | `/backup-points/:id` | Get backup point |
| GET | `/search/global` | Global search |
| GET | `/search/issues` | Issue search |
| GET | `/search/attachments` | Attachment search |
| POST | `/restore` | Start restore job |
| POST | `/sdi/scan` | Trigger SDI scan |
| GET | `/sdi/results` | List SDI results |
| GET | `/resilience/inventory` | Inventory grid data |
| POST | `/purge/cascade` | Purge cascade (protected types blocked) |

---

## Logs and Troubleshooting

```bash
# View live application logs
docker compose logs -f

# Check container health
docker compose ps

# Run health check script
./healthcheck.sh

# Inspect a specific container
docker compose exec app sh
```

**Common issues:**

| Symptom | Solution |
|---|---|
| Server fails to start | Check that all required env vars are set in `.env`; run `docker compose logs app` |
| `OAUTH_TOKEN_ENCRYPTION_KEY` error | Must be exactly 64 hex characters — regenerate with `openssl rand -hex 32` |
| OAuth redirect mismatch | Ensure `ATLASSIAN_REDIRECT_URI` in `.env` exactly matches the URI in the Atlassian Developer Console |
| Webhooks not firing | Set `WEBHOOK_CALLBACK_URL` to a publicly reachable URL; use ngrok for local dev |
