# jira_workload

![Build](https://img.shields.io/badge/build-passing-brightgreen)
![Node](https://img.shields.io/badge/node-%3E%3D18-blue)
![Podman](https://img.shields.io/badge/podman-rootless-purple)
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

- **Podman** (rootless, no daemon required) + **podman-compose**
  - macOS: `brew install podman podman-compose && podman machine init && podman machine start`
  - Fedora/RHEL: `sudo dnf install -y podman podman-compose`
  - Debian/Ubuntu: `sudo apt-get install -y podman && pip install podman-compose`
  - Windows: install [Podman Desktop](https://podman-desktop.io) **or** run from a WSL2 terminal with Podman installed
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
| Manual | `podman-compose -f podman-compose.yml up --build` |

The application starts at **http://localhost:4000**.

### 3. Stop

| Platform | Command |
|---|---|
| macOS / Linux | `./stop.sh` |
| Windows (PowerShell) | `.\stop.ps1` |
| Windows (CMD) | `stop.bat` |

---

## How It Works

Want to understand what jira_workload does under the hood — how backup jobs flow,
what the restore pipeline does, how Podman fits in, and what "purge-protected" means?

**[Read the Architecture Overview →](docs/ARCHITECTURE.md)**

It covers:
- What the platform does and why
- How the major components interact (OAuth, backup engine, restore engine, SDI, Resilience Module)
- End-to-end data flow diagrams (backup and restore paths)
- Key concepts: backup points, conflict modes, purge cascade boundary, protected objects
- Deployment topology: what runs locally in Podman vs. what is in Atlassian cloud

---

## Documentation

| Document | Description |
|---|---|
| [Architecture Overview](docs/ARCHITECTURE.md) | How it works: components, data flows, key concepts, deployment |
| [Installation Guide](docs/INSTALLATION.md) | Detailed setup for all platforms |
| [User Guide](docs/USER_GUIDE.md) | How to use every feature |
| [Demo Walkthrough](docs/DEMO.md) | Step-by-step demo with sample payloads |
| [OAuth Setup](OAUTH_SETUP.md) | Atlassian OAuth configuration reference |
| [Architecture ADRs](docs/architecture/) | Per-sprint architecture decision records |

---

## Development (without Podman / local Node.js)

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
