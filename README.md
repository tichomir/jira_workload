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
ATLASSIAN_REDIRECT_URI=https://<your-ngrok-id>.ngrok-free.app/oauth/callback  # must be HTTPS — see OAUTH_SETUP.md § 2a
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

## Atlassian App Registration & OAuth Setup

Before you can click **Connect to Atlassian**, you must register an OAuth 2.0 (3LO) app
in the Atlassian Developer Console and configure an **HTTPS** redirect URI.

### Why HTTPS?

Atlassian's OAuth 2.0 platform rejects all non-HTTPS callback URLs — including
`http://localhost`. Using an `http://` redirect URI produces this error at connect time:

```
Redirect URI must be a valid HTTPS URL
```

This is enforced at both the Developer Console (the form will not save an `http://` URL)
and at the Atlassian authorization server at runtime.

### Step-by-step: register your app

1. Go to [developer.atlassian.com/console/myapps/](https://developer.atlassian.com/console/myapps/)
2. Click **Create** → **OAuth 2.0 integration** → enter a name (e.g. `jira-workload-local`) → **Create**
3. Open the **Authorization** tab → **OAuth 2.0 (3LO)** → **Add** next to **Callback URL**
4. Enter your HTTPS redirect URI (see options below) and click **Save changes**
5. Open the **Permissions** tab → add the required Jira scopes (see `OAUTH_SETUP.md §3`)
6. Open the **Settings** tab → copy **Client ID** and **Client Secret** into `.env`

### Choosing a local HTTPS redirect URI

**Option A — ngrok (recommended, quickest)**

```bash
# 1. Install ngrok and authenticate
brew install ngrok           # macOS
ngrok config add-authtoken <your-ngrok-token>

# 2. Start the app stack, then in a second terminal:
ngrok http 4000
# → shows: https://abc123.ngrok-free.app -> http://localhost:4000
```

Redirect URI to register in the Atlassian Developer Console:

```
https://abc123.ngrok-free.app/oauth/callback
```

Set in `.env`:

```dotenv
ATLASSIAN_REDIRECT_URI=https://abc123.ngrok-free.app/oauth/callback
```

**Option B — Caddy + mkcert (offline / stable URL)**

Redirect URI to register in the Atlassian Developer Console:

```
https://localhost:4443/oauth/callback
```

Set in `.env`:

```dotenv
ATLASSIAN_REDIRECT_URI=https://localhost:4443/oauth/callback
```

See **[OAUTH_SETUP.md](OAUTH_SETUP.md)** for full step-by-step instructions for both options,
including Windows instructions and the Caddy Podman Compose snippet.

### Connection flows

| Flow | How to use |
|---|---|
| **Express path** | Click **Connect with Atlassian** on `/connect.html` — you are redirected to Atlassian to authorise, then returned to the callback URL automatically |
| **Manual path** | Enter Client ID, Client Secret, Site URL, and the Redirect URI directly in the form on `/connect.html` |

Both flows require the redirect URI in `.env` to **exactly match** the one registered in
the Atlassian Developer Console — including path, no trailing slash.

### Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `Redirect URI must be a valid HTTPS URL` | `ATLASSIAN_REDIRECT_URI` starts with `http://` | Use an ngrok or Caddy HTTPS URL — see OAUTH_SETUP.md §2a |
| `redirect_uri_mismatch` | URI in `.env` does not exactly match the one in the Atlassian Console | Copy the URI character-for-character; check for trailing slashes |
| App not saved in Developer Console | You tried to enter an `http://` callback — the Console rejects it silently or shows an inline error | Enter an `https://` URL |

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

# Run integration tests (OAuth callback + manage endpoint)
npm run test:integration
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
| `ATLASSIAN_REDIRECT_URI` | Registered HTTPS redirect URI — must be `https://` (see `OAUTH_SETUP.md` § 2a) |
| `OAUTH_TOKEN_ENCRYPTION_KEY` | 64-char hex AES-256-GCM key — generate with `openssl rand -hex 32` |

---

## Testing

### Unit / sprint tests

```bash
npm test
```

Runs all test suites in `tests/` (sprint1–sprint10).

### Integration tests

Integration tests cover the full OAuth callback → connection store → manage API flow using
mocked Atlassian token endpoints and credentials loaded from `.env.test`.

```bash
# 1. Create the test credentials file (first time only):
cp .env.example .env.test
# Then fill in the same credentials you use for development.

# 2. Run integration tests:
npm run test:integration
```

The `.env.test` file must contain at minimum:

| Variable | Example |
|---|---|
| `ATLASSIAN_CLIENT_ID` | `1hCMINKiuGDOyWuGkI4BnMQhq8mwPEa9` |
| `ATLASSIAN_CLIENT_SECRET` | `ATOA2...` |
| `ATLASSIAN_REDIRECT_URI` | `https://localhost:4443/oauth/callback` |
| `OAUTH_TOKEN_ENCRYPTION_KEY` | 64-char hex string |

Atlassian API calls are mocked — no real network requests are made. The tests validate:
- Successful callback stores an encrypted connection record keyed by `connectionId`
- Callback response is a `302` redirect to `/callback.html?connectionId=<id>&status=success`
- `GET /api/v1/integrations/:connectionId` returns `cloudId`, `siteName`, `grantedScopes`
- Missing `code` param → `302` redirect with `STATE_INVALID`
- Invalid / tampered state → `302` redirect with `STATE_INVALID`

**In CI:** set the four env vars directly as CI secrets instead of committing `.env.test`.

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
