# Installation Guide

## Prerequisites

### Docker (recommended — works on all platforms)

| Platform | Install |
|---|---|
| macOS | [Docker Desktop for Mac](https://docs.docker.com/desktop/install/mac-install/) — supports Intel and Apple Silicon (M1/M2/M3) |
| Windows 10/11 | [Docker Desktop for Windows](https://docs.docker.com/desktop/install/windows-install/) — requires WSL2 or Hyper-V |
| Ubuntu / Debian | `sudo apt-get install docker.io docker-compose-plugin` |
| Fedora / RHEL | `sudo dnf install docker docker-compose-plugin` |

Verify:
```bash
docker --version          # Docker 24.x or later recommended
docker compose version    # Compose v2 required (not the legacy docker-compose v1)
```

### Node.js (without Docker)

Node.js >= 18 is required.  
Download from [nodejs.org](https://nodejs.org) or use a version manager:

```bash
# macOS / Linux (nvm)
nvm install 20
nvm use 20

# Windows — use the official installer or fnm
fnm install 20
fnm use 20
```

---

## Installation

### Option A: Docker (recommended)

**Step 1 — Clone the repository**

```bash
git clone <repository-url>
cd jira_workload
```

**Step 2 — Configure environment**

```bash
# macOS / Linux
cp .env.example .env

# Windows CMD
copy .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

Open `.env` in a text editor and set the four required values:

```dotenv
ATLASSIAN_CLIENT_ID=<from Atlassian Developer Console>
ATLASSIAN_CLIENT_SECRET=<from Atlassian Developer Console>
ATLASSIAN_REDIRECT_URI=http://localhost:4000/oauth/callback
OAUTH_TOKEN_ENCRYPTION_KEY=<64 hex chars — see generation command below>
```

**Generating an encryption key:**

```bash
# macOS / Linux
openssl rand -hex 32

# Windows PowerShell
-join ((1..32) | % { '{0:x2}' -f (Get-Random -Max 256) })

# Node.js (any platform)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Step 3 — Start**

```bash
# macOS / Linux
./start.sh

# Windows PowerShell
.\start.ps1

# Windows CMD
start.bat
```

The application will be available at **http://localhost:4000**.

---

### Option B: Without Docker (local Node.js)

**Step 1 — Clone and install dependencies**

```bash
git clone <repository-url>
cd jira_workload
npm install
```

**Step 2 — Configure environment** (same as Option A Step 2)

**Step 3 — Start**

```bash
npm start       # production mode
npm run dev     # development mode with auto-restart (requires nodemon)
```

---

## Platform-Specific Notes

### macOS (Apple Silicon — M1/M2/M3)

The Docker image is built for both `linux/amd64` and `linux/arm64`.
Docker Desktop on Apple Silicon pulls the native `arm64` image automatically —
no Rosetta emulation required.

### Windows

- **Docker Desktop** requires WSL2 (Windows Subsystem for Linux 2).
  Enable WSL2 by running in an Administrator PowerShell:
  ```powershell
  wsl --install
  ```
  Then restart and install Docker Desktop.

- Run `start.ps1` in PowerShell (not CMD) for the best experience.
  If you see an execution policy error:
  ```powershell
  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
  ```

- If you use `start.bat`, port is hardcoded to 4000. Use `start.ps1` to
  pick up a custom `PORT` from `.env`.

### Linux

Ensure your user is in the `docker` group to run Docker without `sudo`:

```bash
sudo usermod -aG docker $USER
# Log out and back in for the group change to take effect
```

---

## Atlassian OAuth Setup

See [OAUTH_SETUP.md](../OAUTH_SETUP.md) for step-by-step Atlassian Developer
Console configuration.

The minimum scopes required are listed there. The Redirect URI registered in
the Atlassian console **must exactly match** `ATLASSIAN_REDIRECT_URI` in `.env`.

---

## Verifying the Installation

```bash
# Check the health endpoint
curl http://localhost:4000/health
# Expected: {"status":"ok"}

# Run the full healthcheck script (macOS / Linux)
./healthcheck.sh

# View running containers
docker compose ps

# View application logs
docker compose logs -f
```

---

## Upgrading

```bash
git pull
./stop.sh        # or .\stop.ps1
./start.sh       # or .\start.ps1
```

The `--build` flag in `start.sh` ensures the Docker image is rebuilt with the
latest source.

---

## Uninstalling

```bash
# Stop containers and remove named volumes (deletes all backup data)
docker compose down -v

# Remove the Docker image
docker rmi jira-workload:latest
```

---

## Troubleshooting

| Symptom | Solution |
|---|---|
| Server fails to start | Verify all required env vars are set in `.env`; run `docker compose logs app` to see the startup error |
| `OAUTH_TOKEN_ENCRYPTION_KEY` invalid | Must be exactly 64 hex characters; regenerate with `openssl rand -hex 32` (macOS/Linux) or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| OAuth redirect mismatch error | `ATLASSIAN_REDIRECT_URI` in `.env` must **exactly** match the Redirect URI registered in the Atlassian Developer Console — no trailing slash |
| Webhooks not receiving events | Set `WEBHOOK_CALLBACK_URL` to a publicly reachable HTTPS URL; use [ngrok](https://ngrok.com) (`ngrok http 4000`) for local development |
| Port 4000 already in use | Set `PORT=4001` (or any free port) in `.env`; the Docker port mapping updates automatically |
| `permission denied` running `start.sh` on Linux/macOS | Run `chmod +x start.sh stop.sh healthcheck.sh` then retry |
| Container exits immediately after start | Run `docker compose logs app` — most commonly a missing or malformed env var; compare your `.env` against `.env.example` |
| Docker build fails on Apple Silicon (M1/M2/M3) | Ensure Docker Desktop is updated to 4.x or later; the image ships a native `linux/arm64` layer and does not require Rosetta |
| Backup data lost after restart | Use `docker compose down` **without** the `-v` flag to preserve named volumes; `-v` permanently deletes all backup data |
| `ECONNREFUSED` connecting to Jira API | Confirm your Atlassian OAuth app has the correct scopes and the `ATLASSIAN_CLIENT_ID` / `ATLASSIAN_CLIENT_SECRET` values are not swapped |
