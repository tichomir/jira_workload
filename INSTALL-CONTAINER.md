# INSTALL-CONTAINER.md — Container Registry Install & Upgrade Guide

Install and upgrade **jira_workload** using pre-built images from a container
registry.  **No git clone required** — you only need Podman (or Docker) and a
text editor.

> **TODO — Registry images not yet published**
> The registry paths below use `ghcr.io/OWNER/jira-workload` as a placeholder.
> Before this method is usable, the project owner must:
> 1. Build and push the image to a container registry (e.g. GitHub Container Registry).
> 2. Replace every occurrence of `ghcr.io/OWNER/jira-workload` in this document
>    with the real published path (e.g. `ghcr.io/myorg/jira-workload`).
>
> If you have access to the source repository, use the git-based method in
> **INSTALL.md** instead until images are published.

---

## Contents

1. [Prerequisites](#1-prerequisites)
2. [First-Time Install](#2-first-time-install)
3. [Upgrade](#3-upgrade)
4. [Version Pinning](#4-version-pinning)
5. [Rollback](#5-rollback)
6. [Data Persistence Reference](#6-data-persistence-reference)
7. [Verifying the Installation](#7-verifying-the-installation)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Prerequisites

| Tool | Minimum version | Install |
|---|---|---|
| **Podman** *(recommended)* | 4.x | `brew install podman` (macOS) · `dnf install podman` (Fedora/RHEL) · `apt install podman` (Debian/Ubuntu) · [Podman Desktop](https://podman-desktop.io) (Windows) |
| **podman-compose** | 1.x | `pip install podman-compose` or `pipx install podman-compose` |
| **Docker** *(alternative)* | 24.x | [docs.docker.com/get-docker](https://docs.docker.com/get-docker/) |
| `curl` or `wget` | any | Used to download the compose file and env template (pre-installed on most systems) |

**git is NOT required.**

Verify your container runtime:

```bash
# Podman
podman --version
podman-compose --version

# Docker (alternative)
docker --version
docker compose version
```

> **macOS only (Podman):** The Podman VM must be initialised and started once:
> ```bash
> podman machine init && podman machine start
> ```
> Subsequent starts only need `podman machine start`.

---

## 2. First-Time Install

### Step 1 — Create a working directory

Choose any location on your machine — this directory will hold your `.env`
configuration and the compose file.  Your persistent data (connections, backup
metadata) is stored in named volumes managed by Podman/Docker and is
**independent of this directory**.

```bash
mkdir ~/jira-workload && cd ~/jira-workload
```

### Step 2 — Download the compose file

#### Podman users

```bash
curl -fsSL \
  https://raw.githubusercontent.com/OWNER/jira_workload/main/podman-compose.registry.yml \
  -o podman-compose.yml
```

> **If the registry compose file is not yet published**, create it manually.
> Copy the content from the [Compose File Template](#compose-file-template)
> section at the end of this document into a file named `podman-compose.yml`.

#### Docker users

```bash
curl -fsSL \
  https://raw.githubusercontent.com/OWNER/jira_workload/main/docker-compose.yml \
  -o docker-compose.yml
```

### Step 3 — Download the environment template

```bash
curl -fsSL \
  https://raw.githubusercontent.com/OWNER/jira_workload/main/.env.example \
  -o .env.example
```

### Step 4 — Create and configure `.env`

```bash
# macOS / Linux
cp .env.example .env

# Windows CMD
copy .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

Open `.env` in a text editor and fill in the **four required values**:

```dotenv
ATLASSIAN_CLIENT_ID=<from Atlassian Developer Console>
ATLASSIAN_CLIENT_SECRET=<from Atlassian Developer Console>

# Must be HTTPS — Atlassian rejects http:// callback URLs.
# For local dev use ngrok (see OAUTH_SETUP.md) or Caddy + mkcert.
ATLASSIAN_REDIRECT_URI=https://<your-ngrok-id>.ngrok-free.app/oauth/callback

# 64 hex characters — generate once with one of the commands below:
OAUTH_TOKEN_ENCRYPTION_KEY=<64 hex chars>
```

**Generate an encryption key** (run once, copy the output into `.env`):

```bash
# macOS / Linux
openssl rand -hex 32

# Windows PowerShell
-join ((1..32) | % { '{0:x2}' -f (Get-Random -Max 256) })

# Any platform (Node.js)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> Registering your Atlassian app and setting up the required HTTPS redirect URI
> are covered in **OAUTH_SETUP.md** (download from the project repository or
> read it at the GitHub URL for your release tag).

### Step 5 — Pull and start

#### Podman

```bash
# Pull the image first (optional — up will pull automatically if not present)
podman pull ghcr.io/OWNER/jira-workload:latest

# Start in detached mode
podman-compose up -d
```

#### Docker

```bash
docker compose up -d
```

The application is available at **http://localhost:4000**.

On first start the app creates an empty `db.json` in the `db_data` named
volume.  All connections, OAuth tokens, and backup metadata are written there.

---

## 3. Upgrade

> **Your connections and backup data are safe.**
> Named volumes (`db_data`, `backup_data`, `sdi_tmp`, `export_data`) are
> **never removed** by the commands below.
> **Do not** add the `-v` flag to `down` during an upgrade — it permanently
> deletes all stored data.

### Podman

```bash
# 1. Pull the latest image from the registry
podman pull ghcr.io/OWNER/jira-workload:latest

# 2. Stop the running stack (volumes are preserved)
podman-compose down

# 3. Start with the new image
podman-compose up -d
```

### Docker

```bash
docker compose pull
docker compose down
docker compose up -d
```

### What is preserved

| Data | Stored in | Preserved across upgrade? |
|---|---|---|
| OAuth connections & tokens | `db_data` volume | Yes |
| Backup metadata | `db_data` volume | Yes |
| Backup binary attachments | `backup_data` volume | Yes |
| SDI temporary files | `sdi_tmp` volume | Yes |
| Restore exports | `export_data` volume | Yes |
| Your `.env` file | Working directory | Yes (not touched by pull/restart) |

---

## 4. Version Pinning

Locking to a specific image tag is recommended for production stability.
Replace `latest` with a release tag everywhere the image is referenced.

### In `podman-compose.yml` / `docker-compose.yml`

```yaml
services:
  app:
    image: ghcr.io/OWNER/jira-workload:1.2.0   # ← pinned tag
```

### On the command line

```bash
# Pull a specific version
podman pull ghcr.io/OWNER/jira-workload:1.2.0

# Or set the tag as an environment variable and reference it from the compose file
export JIRA_WORKLOAD_TAG=1.2.0
podman-compose up -d
```

To see all available tags, visit the registry page:

```
https://ghcr.io/OWNER/jira-workload
```

> **Tip:** When pinning, update the tag in `podman-compose.yml` *before*
> running `podman-compose up -d` so the compose file and running container stay
> in sync.

---

## 5. Rollback

If an upgrade breaks something, roll back to the previous tag in three steps.

### Step 1 — Identify the previous tag

```bash
# List locally available image tags
podman images ghcr.io/OWNER/jira-workload

# Example output:
# REPOSITORY                         TAG       IMAGE ID      CREATED       SIZE
# ghcr.io/OWNER/jira-workload        latest    abc123def456  2 hours ago   180MB
# ghcr.io/OWNER/jira-workload        1.1.0     def456abc789  3 days ago    175MB
```

If the previous image is no longer cached locally, pull it by tag:

```bash
podman pull ghcr.io/OWNER/jira-workload:1.1.0
```

### Step 2 — Update the compose file to the previous tag

Edit `podman-compose.yml` (or `docker-compose.yml`):

```yaml
services:
  app:
    image: ghcr.io/OWNER/jira-workload:1.1.0   # ← rolled-back tag
```

### Step 3 — Restart

```bash
# Podman
podman-compose down
podman-compose up -d

# Docker
docker compose down
docker compose up -d
```

> **Data safety:** Named volumes are not affected by rollback.
> Your connections and backup data remain intact.

---

## 6. Data Persistence Reference

All user-generated state lives in named volumes managed by Podman/Docker:

| Volume | Mount point inside container | Contents |
|---|---|---|
| `db_data` | `/data` | `db.json` — OAuth connections, cloud sites, backup points |
| `backup_data` | `/app/data/backups` | Backed-up Jira binary attachments |
| `sdi_tmp` | `/app/data/sdi-tmp` | SDI scanner temporary files |
| `export_data` | `/app/data/exports` | JSON + ZIP restore exports |

### Backing up volumes before an upgrade

```bash
# Export each volume to a tar archive
podman volume export db_data      > db_data_backup_$(date +%Y%m%d).tar
podman volume export backup_data  > backup_data_backup_$(date +%Y%m%d).tar
```

### Restoring a volume from a backup

```bash
podman volume import db_data db_data_backup_20260101.tar
```

---

## 7. Verifying the Installation

```bash
# Health endpoint
curl http://localhost:4000/health
# Expected: {"status":"ok"}

# View running containers
podman-compose ps

# Stream logs
podman-compose logs -f

# Check data volume is being written to
podman exec $(podman ps -qf name=app) ls /data/
```

---

## 8. Troubleshooting

| Symptom | Solution |
|---|---|
| `image not known` / `manifest unknown` | Registry images not yet published — see the TODO note at the top of this document; use the git-based install from **INSTALL.md** instead |
| `Redirect URI must be a valid HTTPS URL` | `ATLASSIAN_REDIRECT_URI` starts with `http://` — Atlassian requires HTTPS for all callback URLs; use ngrok or Caddy (see **OAUTH_SETUP.md**) |
| Settings lost after upgrade | You ran `podman-compose down -v`; the `-v` flag deletes named volumes — do not use it during upgrades |
| `OAUTH_TOKEN_ENCRYPTION_KEY` changed | Changing the key makes existing encrypted tokens unreadable — connections must be re-created |
| Port 4000 already in use | Set `PORT=4001` (or any free port) in `.env` and restart |
| Podman machine not running (macOS) | Run `podman machine start` then retry |
| `podman-compose: command not found` | Install with `pip install podman-compose` or `pipx install podman-compose` |
| Container exits immediately | Run `podman-compose logs app` — most commonly a missing or malformed env var; compare `.env` against `.env.example` |
| `db.json` is recreated empty after restart | You ran `podman-compose down -v` — connections must be re-created; going forward use `down` without `-v` |

---

## Compose File Template

Use this if the hosted registry compose file is not yet available.
Save it as `podman-compose.yml` in your working directory.

```yaml
version: "3.9"

# jira_workload — container registry install (no git clone required)
# Replace ghcr.io/OWNER/jira-workload with the real published registry path.
# See INSTALL-CONTAINER.md for full instructions.

services:
  app:
    image: ghcr.io/OWNER/jira-workload:latest
    env_file:
      - .env
    environment:
      NODE_ENV: ${NODE_ENV:-production}
      PORT:     ${PORT:-4000}
      DATA_DIR: /data
    ports:
      - "${PORT:-4000}:${PORT:-4000}"
    volumes:
      - db_data:/data
      - backup_data:/app/data/backups
      - sdi_tmp:/app/data/sdi-tmp
      - export_data:/app/data/exports
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:${PORT:-4000}/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s
    restart: unless-stopped

volumes:
  db_data:
    driver: local
  backup_data:
    driver: local
  sdi_tmp:
    driver: local
  export_data:
    driver: local
```
