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

## Choosing your install method

| I want to… | Use this guide |
|---|---|
| Just run the app — no source code needed | **[INSTALL-CONTAINER.md](INSTALL-CONTAINER.md)** — pull a pre-built image from a container registry; no git required |
| Contribute, modify source, or run from git | **[INSTALL-GIT.md](INSTALL-GIT.md)** — clone the repo, use an override file so `git pull` never conflicts with your local settings |

---

## Quick Start — Container (no git required)

Pull the pre-built image, drop in your `.env`, and start. No source code needed.
See **[INSTALL-CONTAINER.md](INSTALL-CONTAINER.md)** for the full step-by-step guide including
upgrade, rollback, version pinning, and data backup.

```bash
mkdir ~/jira-workload && cd ~/jira-workload
# Download the compose file and env template, fill in .env, then:
podman-compose up -d
```

---

## Quick Start — Git (contribute / run from source)

Clone the repo, copy the override template so your local tweaks never block `git pull`,
fill in `.env`, and start.
See **[INSTALL-GIT.md](INSTALL-GIT.md)** for the full step-by-step guide including
upgrade, local customisation, and troubleshooting.

```bash
git clone <repository-url>
cd jira_workload
cp .env.example .env
cp podman-compose.override.yml.example podman-compose.override.yml
# Fill in .env, then:
./start.sh          # macOS / Linux
.\start.ps1         # Windows PowerShell
```

---

## How It Works

Want to understand what jira_workload does under the hood — how backup jobs flow,
what the restore pipeline does, how Podman fits in, and what "purge-protected" means?

**[Read the Architecture Overview →](docs/ARCHITECTURE.md)**

---

## Documentation

| Document | Description |
|---|---|
| [INSTALL-GIT.md](INSTALL-GIT.md) | Git-based install, upgrade without merge conflicts, local customisation |
| [INSTALL-CONTAINER.md](INSTALL-CONTAINER.md) | Container registry install (no git), upgrade, rollback, version pinning |
| [OAUTH_SETUP.md](OAUTH_SETUP.md) | Atlassian OAuth app registration, HTTPS redirect URI setup (ngrok / Caddy), scope list |
| [Architecture Overview](docs/ARCHITECTURE.md) | How it works: components, data flows, key concepts, deployment |
| [User Guide](docs/USER_GUIDE.md) | How to use every feature |
| [Demo Walkthrough](docs/DEMO.md) | Step-by-step demo with sample payloads |
| [Architecture ADRs](docs/architecture/) | Per-sprint architecture decision records |

---

## Development (local Node.js without containers)

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env   # then edit .env

# Run in development mode (auto-restart on file changes)
npm run dev

# Run tests
npm test

# Run integration tests (OAuth callback + manage endpoint)
npm run test:integration
```

Node.js >= 18 is required.

---

## Health Check

```bash
curl http://localhost:4000/health
# {"status":"ok"}
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
  db/             In-memory data store
  public/         Static frontend HTML pages
docs/
  architecture/   Per-sprint architecture decision records
  INSTALLATION.md Detailed installation guide (legacy — see INSTALL-GIT.md / INSTALL-CONTAINER.md)
  USER_GUIDE.md   Feature usage guide
  DEMO.md         Demo walkthrough
config/
  deployment.env.example  Full env-var reference with per-platform notes
packages/
  shared-types/   TypeScript interfaces shared across backend and frontend
```
