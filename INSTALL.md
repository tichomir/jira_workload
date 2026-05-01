# INSTALL.md — Installation, Upgrade & Data Persistence Guide

This guide explains how to install jira_workload from scratch, upgrade to a new
version **without losing any connections or settings**, and back up your data.

---

## Prerequisites

| Tool | Minimum version | Notes |
|---|---|---|
| Podman | 4.x | `brew install podman` (macOS) · `dnf install podman` (Fedora/RHEL) · `apt install podman` (Debian/Ubuntu) |
| podman-compose | 1.x | `pip install podman-compose` or `pipx install podman-compose` |
| Node.js | 18+ | Only required if running **without** containers |

Verify:
```bash
podman --version
podman-compose --version
```

> **macOS only:** initialise the Podman VM once before anything else:
> ```bash
> podman machine init && podman machine start
> ```

---

## How Data Is Stored

All user-generated state is written to a **persistent data directory** that lives
**outside** the application source tree.  This means a `git pull` + image rebuild
never touches your connections or backup data.

| Location | What is stored |
|---|---|
| `$DATA_DIR/db.json` | OAuth connections, cloud sites, backup points, all in-memory state |
| `backup_data` volume | Backed-up Jira binary attachments |
| `sdi_tmp` volume | SDI scanner temporary files |
| `export_data` volume | JSON + ZIP restore exports |

`DATA_DIR` resolution order:
1. `DATA_DIR` environment variable (explicit — set in `.env` or compose override)
2. `~/.dcc-jira` — default for local `npm start` / `npm run dev`
3. `/data` — default inside containers (podman-compose sets `DATA_DIR=/data`)

The `/data` path inside the container is mounted as the named volume `db_data`,
so it survives container restarts, image rebuilds, and `podman-compose down`
(without `-v`).

---

## First Install

### Step 1 — Clone the repository

```bash
git clone <repository-url>
cd jira_workload
```

### Step 2 — Configure environment

```bash
# macOS / Linux
cp .env.example .env

# Windows CMD
copy .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

Open `.env` and fill in the **four required values**:

```dotenv
ATLASSIAN_CLIENT_ID=<from Atlassian Developer Console>
ATLASSIAN_CLIENT_SECRET=<from Atlassian Developer Console>
# Must be HTTPS — see OAUTH_SETUP.md for ngrok / Caddy options
ATLASSIAN_REDIRECT_URI=https://<your-ngrok-id>.ngrok-free.app/oauth/callback
OAUTH_TOKEN_ENCRYPTION_KEY=<64 hex chars — see generation command below>
```

**Generate an encryption key** (run once, save the output to `.env`):
```bash
# macOS / Linux
openssl rand -hex 32

# Node.js (any platform)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 3 — Start

```bash
# macOS / Linux
./start.sh

# Windows PowerShell
.\start.ps1

# Windows CMD
start.bat

# Manual
podman-compose -f podman-compose.yml up --build -d
```

The app is available at **http://localhost:4000**.

On first start, `db.json` does not yet exist — the app initialises an empty store
and creates `$DATA_DIR/db.json` after the first write (e.g. after connecting to
Atlassian).

---

## Upgrading

> **Your connections and settings are safe** — the `db_data` named volume is not
> touched by any of these steps.

```bash
# 1. Pull the latest source
git pull

# 2. Stop the running stack (does NOT remove volumes)
./stop.sh          # macOS / Linux
.\stop.ps1         # Windows PowerShell

# 3. Rebuild and restart
./start.sh         # macOS / Linux
.\start.ps1        # Windows PowerShell
```

Alternatively, if you are pulling a pre-built image from the registry:

```bash
podman pull ghcr.io/<owner>/jira_workload:latest
podman-compose -f podman-compose.yml up -d
```

> **Never run `podman-compose down -v`** during an upgrade — the `-v` flag removes
> named volumes and **permanently deletes** your connections and backup data.

---

## Using a Pre-built Image (no git clone required)

If you want to share the app with someone who does not need the source code:

1. Give them a `.env` file with their credentials filled in.
2. Give them the following minimal `podman-compose.yml`:

```yaml
version: "3.9"
services:
  app:
    image: ghcr.io/<owner>/jira_workload:latest
    env_file: .env
    environment:
      DATA_DIR: /data
    ports:
      - "4000:4000"
    volumes:
      - db_data:/data
      - backup_data:/app/data/backups
      - sdi_tmp:/app/data/sdi-tmp
      - export_data:/app/data/exports
    restart: unless-stopped
volumes:
  db_data:
  backup_data:
  sdi_tmp:
  export_data:
```

Then:
```bash
podman-compose up -d
```

---

## Custom DATA_DIR (advanced)

If you want to store `db.json` at a specific path (e.g. on an external drive or
a shared NFS mount), set `DATA_DIR` in `.env`:

```dotenv
DATA_DIR=/mnt/shared/jira-workload-data
```

The directory is created automatically on first run if it does not exist.

---

## Backing Up Your Data

To take a snapshot of all connections and settings before an upgrade:

```bash
# Export the db_data volume to a tar archive
podman volume export db_data > db_data_backup_$(date +%Y%m%d).tar

# Also export backup binaries if needed
podman volume export backup_data > backup_data_backup_$(date +%Y%m%d).tar
```

To restore from a backup:
```bash
podman volume import db_data db_data_backup_20260101.tar
```

---

## Complete Uninstall

```bash
# Stop and remove containers AND volumes (permanent data loss)
podman-compose -f podman-compose.yml down -v

# Remove the container image
podman rmi jira-workload:latest
```

---

## Verifying the Installation

```bash
# Health endpoint
curl http://localhost:4000/health
# Expected: {"status":"ok"}

# Check logs
podman-compose -f podman-compose.yml logs -f

# Check persistent data is being written
ls ~/.dcc-jira/        # local (no DATA_DIR set)
# or
podman exec $(podman ps -qf name=app) ls /data/   # inside container
```

---

## Troubleshooting

| Symptom | Solution |
|---|---|
| `db.json` is recreated empty on restart | The volume was removed with `-v`; connections must be re-created |
| `[persist] Cannot create DATA_DIR` | The directory is not writable — check permissions or set a different `DATA_DIR` |
| Settings lost after `git pull` | You ran `podman-compose down -v`; going forward use `down` without `-v` |
| `OAUTH_TOKEN_ENCRYPTION_KEY` changed | Changing the key makes existing encrypted tokens unreadable — connections must be re-created |
| Port 4000 already in use | Set `PORT=4001` in `.env` |

See `docs/INSTALLATION.md` for the full installation guide including HTTPS callback
URL setup (ngrok / Caddy) required by Atlassian OAuth.
