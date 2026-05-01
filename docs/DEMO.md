# Demo Walkthrough — jira_workload

> **Audience:** Prospects, evaluators, and new team members.
> **Goal:** Walk through the complete happy-path end-to-end without engineering assistance.
> **Time:** ~15 minutes for a full live demo; ~5 minutes for a quick browser tour.

---

## Demo Asset

A full happy-path walkthrough recording is available in [`docs/demo-assets/`](demo-assets/):

| Asset | Description |
|---|---|
| [`demo-assets/happy-path-walkthrough.md`](demo-assets/happy-path-walkthrough.md) | Recording instructions and hosted link placeholder |

> **Tip:** To record your own walkthrough use [Kap](https://getkap.co/) (macOS), [ScreenToGif](https://www.screentogif.com/) (Windows), or [Peek](https://github.com/phw/peek) (Linux). For terminal-only flows, [asciinema](https://asciinema.org/) works well.

---

## Prerequisites

Before starting the demo, ensure the following are in place:

| Requirement | Notes |
|---|---|
| Podman (rootless, no daemon) + podman-compose | macOS: `brew install podman podman-compose` · Linux: `sudo dnf install -y podman podman-compose` · Windows: [Podman Desktop](https://podman-desktop.io) |
| Atlassian Developer Console OAuth 2.0 (3LO) app | [Create an app](https://developer.atlassian.com/console/myapps/) |
| `.env` file configured with valid credentials | Copy `.env.example` → `.env`, fill in the four required variables |
| A live Jira Cloud site with at least one project and a few issues | Used throughout the demo |

---

## Section 1 — Local Startup Confirmation

**Objective:** Verify the application starts cleanly and is reachable.

### Steps

1. Open a terminal in the project root directory.
2. Run the platform-appropriate start script:

   | Platform | Command |
   |---|---|
   | macOS / Linux | `./start.sh` |
   | Windows (PowerShell) | `.\start.ps1` |
   | Windows (CMD) | `start.bat` |
   | Manual | `podman-compose -f podman-compose.yml up --build` |

3. Wait for the log line:
   ```
   jira_workload listening on port 4000
   ```
4. Open a browser and navigate to **http://localhost:4000/connect.html**.
5. Alternatively, run the health check from a terminal:
   ```bash
   curl http://localhost:4000/health
   ```

### Expected Outcome

- Podman builds the image and starts the container without errors.
- The health endpoint returns:
  ```json
  { "status": "ok" }
  ```
- The browser displays the **Connect Jira Cloud** page with the Express and Manual connection options visible.

### Screenshot

![Section 1 — Startup and Health Check](screenshots/01-startup-health.png)

> _Placeholder: replace with a screenshot of the Connect page loaded in the browser, or the terminal showing `{"status":"ok"}`._

---

## Section 2 — Connecting a Jira Cloud Site via Express OAuth

**Objective:** Authorise jira_workload to access a Jira Cloud site using the one-click Express OAuth path.

### Steps

1. Navigate to **http://localhost:4000/connect.html** in your browser.
2. Click **"Connect with Atlassian"** (the Express path button).
3. You are redirected to `auth.atlassian.com`. Sign in with your Atlassian account if prompted.
4. On the permission consent screen, review the requested scopes and click **"Accept"**.
5. Atlassian redirects back to the callback URL. The page automatically advances to **http://localhost:4000/callback.html**.
6. If your account is linked to more than one Atlassian site, a **site selector dropdown** appears — choose the target site and click **"Connect"**.
7. The page confirms the connection and lists the granted scopes.

### Expected Outcome

- The callback page displays a success banner:
  > **Connection established** — `<your-site>.atlassian.net` connected successfully.
- All 20 required OAuth scopes appear as green checkmarks.
- If `read:board-scope:jira-software` is missing, a non-blocking amber banner is shown:
  > Board and Sprint data will be excluded from backups.
- The integration is now visible at **http://localhost:4000/manage.html**.

### Screenshot

![Section 2 — OAuth Callback Success](screenshots/02-oauth-success.png)

> _Placeholder: replace with a screenshot of the callback page showing the success banner and scope validation list._

---

## Section 3 — Triggering a Backup and Viewing the Backup Point

**Objective:** Run a full JQL backup of the connected Jira site and confirm the backup point is created.

### Steps

1. Navigate to **http://localhost:4000/manage.html**.
2. Locate the connected integration in the list.
3. Click **"Back Up Now"** next to the integration.
4. The UI shows a progress indicator: _Backup running…_
5. Wait for the status to change to **"Completed"** (may take 10–60 seconds depending on project size).
6. Click the backup point timestamp to open the **Backup Point Detail** view.

### Expected Outcome

- A new backup point entry appears in the integration's backup history with:
  - Status: `completed`
  - Timestamp: current date/time
  - Object counts for Issues, Workflows, Custom Fields, Attachments
- The backup point detail shows a summary of what was captured.

### API verification (optional):

```bash
INTEGRATION_ID="<your-integration-id>"

# Trigger backup
curl -s -X POST \
  http://localhost:4000/api/v1/integrations/${INTEGRATION_ID}/backup \
  -H "Content-Type: application/json" \
  -d '{"scope": "all"}'

# List backup points
curl -s http://localhost:4000/api/v1/integrations/${INTEGRATION_ID}/backup-points \
  | python3 -m json.tool
```

### Screenshot

![Section 3 — Backup Triggered and Completed](screenshots/03-backup-complete.png)

> _Placeholder: replace with a screenshot of the manage page showing a completed backup point with object counts._

---

## Section 4 — Browsing Backed-Up Issues and Attachments

**Objective:** Search and browse the captured Jira data inside a backup point.

### Steps

1. Navigate to **http://localhost:4000/browse.html**.
2. Select the backup point created in Section 3 from the dropdown.
3. In the **Issue Search** panel:
   - Type a keyword (e.g. `login`) in the search box.
   - Use the filter panel to narrow by **Issue Type** = `Bug` and **Status** = `Open`.
   - Click **"Search"**.
4. Click an issue in the results to open its detail view — note the **Change Indicator** badge (`ADDED`, `MODIFIED`, `DELETED`, or `UNCHANGED`).
5. Switch to the **Attachments** tab and search by filename (e.g. `.pdf`).
6. Click an attachment row to see the file metadata and download option.

### Expected Outcome

- Issue results appear filtered by keyword and selected attributes.
- Each result row shows a **Change Indicator** reflecting how the object changed since the previous backup point.
- Objects not changed since the last backup are hidden by default; a **"Show unchanged"** toggle reveals them.
- Attachments tab lists files with `filename`, `mimeType`, `size`, and `created` columns.

### API reference (optional):

```bash
BACKUP_POINT_ID="<your-backup-point-id>"

# Issue search
curl -s "http://localhost:4000/api/v1/search/issues?backupPointId=${BACKUP_POINT_ID}&q=login&issuetype=Bug&status=Open" \
  | python3 -m json.tool

# Attachment search
curl -s "http://localhost:4000/api/v1/search/attachments?backupPointId=${BACKUP_POINT_ID}&filename=.pdf" \
  | python3 -m json.tool
```

### Screenshot

![Section 4 — Browse Issues with Change Indicators](screenshots/04-browse-issues.png)

> _Placeholder: replace with a screenshot of the browse page showing filtered issue results with change indicator badges visible._

---

## Section 5 — Restoring a Project to an Alternate Location

**Objective:** Restore backed-up project data to a different Jira site using the cross-site restore flow.

### Steps

1. Navigate to **http://localhost:4000/browse.html** and open the backup point from Section 3.
2. In the **Projects** view, select the checkbox next to the project you want to restore (e.g. `PROJ`).
3. Click **"Restore Selected"**.
4. In the Restore wizard:
   - **Conflict Mode:** select `Skip` (default).
   - **Destination:** select `Alternate Location`.
   - In the site selector, choose the target Jira Cloud site (can be the same or a different connected site).
   - If cross-site, complete the **Custom Field Mapping** step — required fields must be mapped before proceeding.
5. Click **"Run Pre-flight Checks"** — all 7 checks must pass (or show non-blocking warnings).
6. Click **"Start Restore"**.
7. Monitor the restore job progress in the **Restore Jobs** panel.

### Expected Outcome

- Pre-flight validation completes with a green summary (or amber warnings for non-blocking items).
- The restore job appears in the panel with status `running`, then `completed`.
- The restored project appears in the target Jira site with:
  - Original issue key stamped as label `original-key:PROJ-123` on each restored issue.
  - Reporter and comment author attribution preserved via ADF headers.

### API reference (optional):

```bash
curl -s -X POST http://localhost:4000/api/v1/restore \
  -H "Content-Type: application/json" \
  -d '{
    "backupPointId": "'${BACKUP_POINT_ID}'",
    "targetIntegrationId": "'${INTEGRATION_ID}'",
    "conflictMode": "skip",
    "destination": "alternate",
    "items": [
      { "nodeType": "JiraProjectNode", "id": "PROJ" }
    ]
  }' | python3 -m json.tool
```

### Screenshot

![Section 5 — Restore to Alternate Location](screenshots/05-restore-alternate.png)

> _Placeholder: replace with a screenshot of the restore wizard showing the alternate location selector and pre-flight results._

---

## Section 6 — Viewing SDI Teaser Findings for a Backup Point

**Objective:** Scan a backup point for sensitive data and review the findings dashboard.

### Steps

1. Navigate to **http://localhost:4000/sdi.html**.
2. Select the backup point from the dropdown.
3. Click **"Run Sensitive Data Scan"**.
4. Wait for the scan to complete (the status indicator transitions from `running` to `complete`).
5. Review the **Findings** panel:
   - Each row shows a **Data Element Type** (Email Address, Credential/API Key, Credit Card/PAN, Phone Number).
   - The **File Type** column shows which file types (`.json`, `.env`, `.csv`, etc.) contained matches.
   - The **Match Count** column shows how many pattern matches were found (raw matched strings are never shown).
   - The **Regulations** column lists applicable regulations: `GDPR`, `CCPA`, `PCI DSS` (Active); `DORA`, `NIS2`, `SOC 2` (Shown).

### Expected Outcome

- Findings are grouped by `dataElementType × fileType`.
- At least one regulation badge appears for each finding.
- Raw matched strings are **never** shown — only aggregate counts.
- An empty findings panel (no matches) is also a valid and clearly communicated outcome.

### API reference (optional):

```bash
# Trigger scan
curl -s -X POST http://localhost:4000/api/v1/sdi/scan \
  -H "Content-Type: application/json" \
  -d '{"backupPointId": "'${BACKUP_POINT_ID}'"}'

# Get results
curl -s "http://localhost:4000/api/v1/sdi/results?backupPointId=${BACKUP_POINT_ID}" \
  | python3 -m json.tool
```

Sample output:
```json
{
  "backupPointId": "bp-001",
  "scannedAt": "2026-05-01T10:10:00.000Z",
  "findings": [
    { "dataElementType": "EMAIL",      "fileType": "json", "matchCount": 14, "regulations": ["GDPR","CCPA"] },
    { "dataElementType": "CREDENTIAL", "fileType": "env",  "matchCount": 2,  "regulations": ["GDPR","CCPA","SOC2"] }
  ]
}
```

### Screenshot

![Section 6 — SDI Findings Dashboard](screenshots/06-sdi-findings.png)

> _Placeholder: replace with a screenshot of the SDI page showing the findings table with regulation badges._

---

## Section 7 — Resilience Module: Projects Inventory

**Objective:** Open the Resilience Module and inspect the protected object inventory for Projects, Workflows, and Custom Fields.

### Steps

1. Navigate to **http://localhost:4000/resilience.html**.
2. The **Protected Object Inventory** sidebar loads with three items:
   - **Projects** (selected by default)
   - **Workflows** (lock icon — purge-protected)
   - **Custom Fields** (lock icon — purge-protected)
3. Confirm the **Projects** inventory grid is visible with the standard column set: `Name`, `Key`, `Type`, `Last Backed Up`, `Backup Count`.
4. Click **"Workflows"** in the sidebar — notice the **lock icon** and **"Purge Protected"** badge on every row in the grid.
5. Click **"Custom Fields"** — same lock badges apply.
6. Attempt to purge a Workflow or Custom Field object:
   - Select a row and click **"Delete"** (if available in the UI).
   - The platform blocks the operation and displays: _This object type is protected from purge cascade operations._

### Expected Outcome

- The sidebar shows all three object types; Projects is pre-selected.
- Workflow and Custom Field rows display a **lock icon** in the `purgeProtectedBadge` column.
- Any attempt to delete/purge a Workflow or Custom Field is blocked at the service layer with a `PURGE_CASCADE_FORBIDDEN` error.
- Projects can be managed normally (no lock badge).

### API reference (optional):

```bash
# List projects inventory
curl -s "http://localhost:4000/api/v1/resilience/inventory?nodeType=JiraProjectNode" \
  | python3 -m json.tool

# List workflows (purge-protected)
curl -s "http://localhost:4000/api/v1/resilience/inventory?nodeType=JiraWorkflowNode" \
  | python3 -m json.tool

# Attempt purge (blocked)
curl -s -X POST http://localhost:4000/api/v1/purge/cascade \
  -H "Content-Type: application/json" \
  -d '{"nodeType": "JiraWorkflowNode", "targetId": "wf-001"}'
# {"error":"PURGE_CASCADE_FORBIDDEN","nodeType":"JiraWorkflowNode"}
```

### Screenshot

![Section 7 — Resilience Module Protected Inventory](screenshots/07-resilience-module.png)

> _Placeholder: replace with a screenshot of the resilience page showing the sidebar with lock icons and the workflow inventory grid._

---

## Full Happy-Path Walkthrough

A recorded walkthrough covering all 7 sections above is linked from the demo assets directory:

**[`docs/demo-assets/happy-path-walkthrough.md`](demo-assets/happy-path-walkthrough.md)**

The recording shows the complete flow from Podman startup to Resilience Module inspection in a single uninterrupted session.

---

## Quick Browser Tour Reference

| URL | What you'll see |
|---|---|
| http://localhost:4000/connect.html | OAuth connection wizard (Section 2) |
| http://localhost:4000/callback.html | OAuth callback and scope validation result |
| http://localhost:4000/manage.html | Integration management and backup history (Section 3) |
| http://localhost:4000/browse.html | Browse and search backed-up data (Section 4) |
| http://localhost:4000/sdi.html | SDI findings dashboard (Section 6) |
| http://localhost:4000/resilience.html | Protected Object Inventory (Section 7) |

---

## Stopping the Demo

```bash
./stop.sh        # macOS / Linux
.\stop.ps1       # Windows PowerShell
stop.bat         # Windows CMD
```

Data volumes persist across restarts. To do a clean reset:

```bash
podman-compose -f podman-compose.yml down -v   # removes named volumes — all backup data is erased
```
