# jira_workload

![Build](https://img.shields.io/badge/build-passing-brightgreen)
![Node](https://img.shields.io/badge/node-%3E%3D18-blue)
![Docker](https://img.shields.io/badge/docker-required-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)

**Jira Cloud workload analytics integration platform** — back up, browse, search,
and restore your Jira Cloud data with sensitive-data intelligence and resilience
module built in.

---

## What is this?

jira_workload is a self-hosted Node.js backend that connects to Jira Cloud via
Atlassian OAuth 2.0 (3LO) and provides:

| Capability | Description |
|---|---|
| **Backup & Discovery** | Full JQL enumeration on first run; incremental cursor on subsequent runs; webhook-driven real-time deltas |
| **Browse & Search** | Global search across Projects, Workflows, and Custom Fields; issue/attachment search with structured filters; Object Explorer with change indicators |
| **Point-in-time Restore** | Dependency-ordered restore pipeline; Skip / Override / Ask conflict modes; cross-site restore with custom-field ID mapping |
| **Sensitive Data Intelligence** | Scan backed-up data for Emails, API Keys, Credit Cards, and Phone Numbers; mapped to GDPR / CCPA / PCI DSS / DORA / NIS2 / SOC 2 |
| **Resilience Module** | Protected Object Inventory for Projects, Workflows, and Custom Fields; platform-layer purge cascade boundary |

---

## Quick Start

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop) (macOS, Windows) or Docker Engine + Compose plugin (Linux)
- An [Atlassian Developer Console](https://developer.atlassian.com/console/myapps/) OAuth 2.0 (3LO) app

### 1. Clone and configure

```bash
git clone <repository-url>
cd jira_workload
cp .env.example .env
```

Open `.env` and fill in:

```
ATLASSIAN_CLIENT_ID=<your-client-id>
ATLASSIAN_CLIENT_SECRET=<your-client-secret>
ATLASSIAN_REDIRECT_URI=http://localhost:4000/oauth/callback
OAUTH_TOKEN_ENCRYPTION_KEY=<64-hex-chars>   # openssl rand -hex 32
```

### 2. Start

| Platform | Command |
|---|---|
| macOS / Linux | `./start.sh` |
| Windows (PowerShell) | `.\start.ps1` |
| Windows (CMD) | `start.bat` |
| Manual | `docker compose up --build` |

The application starts at **http://localhost:4000**.

### 3. Stop

| Platform | Command |
|---|---|
| macOS / Linux | `./stop.sh` |
| Windows (PowerShell) | `.\stop.ps1` |
| Windows (CMD) | `stop.bat` |

---

## Documentation

| Document | Description |
|---|---|
| [Installation Guide](docs/INSTALLATION.md) | Detailed setup for all platforms |
| [User Guide](docs/USER_GUIDE.md) | How to use every feature |
| [Demo Walkthrough](docs/DEMO.md) | Step-by-step demo with sample payloads |
| [OAuth Setup](OAUTH_SETUP.md) | Atlassian OAuth configuration reference |
| [Architecture](docs/architecture/) | Per-sprint architecture decision records |

---

## Development (without Docker)

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env   # then edit .env

# Run in development mode (auto-restart on file changes)
npm run dev

# Run tests
npm test
```

Node.js >= 18 is required.

---

## Environment Variables

See [`.env.example`](.env.example) for the full list with descriptions.
See [`config/deployment.env.example`](config/deployment.env.example) for
detailed documentation including platform-specific notes.

Required at startup:

| Variable | Description |
|---|---|
| `ATLASSIAN_CLIENT_ID` | Atlassian OAuth app Client ID |
| `ATLASSIAN_CLIENT_SECRET` | Atlassian OAuth app Client Secret |
| `ATLASSIAN_REDIRECT_URI` | Registered redirect URI (e.g. `http://localhost:4000/oauth/callback`) |
| `OAUTH_TOKEN_ENCRYPTION_KEY` | 64-char hex AES-256-GCM key — generate with `openssl rand -hex 32` |

---

## Health Check

```bash
curl http://localhost:4000/health
# {"status":"ok"}

# Full health report
./healthcheck.sh
```

---

## Project Structure

```
src/
  app.js          Express app setup and route registration
  server.js       HTTP server entry point
  config/         Environment constants and feature registries
  routes/         Express route handlers (oauth, backup, search, restore, sdi, resilience)
  services/       Business logic (backup engine, restore orchestrator, SDI scanner, etc.)
  db/             In-memory data store (production DB reserved via DATABASE_URL)
  public/         Static frontend HTML pages
docs/
  architecture/   Per-sprint architecture decision records
  INSTALLATION.md Detailed installation guide
  USER_GUIDE.md   Feature usage guide
  DEMO.md         Demo walkthrough
config/
  deployment.env.example  Full env-var reference with per-platform notes
packages/
  shared-types/   TypeScript interfaces shared across backend and frontend
```
