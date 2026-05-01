# Installation Guide

## Prerequisites

### Podman (recommended — works on all platforms, rootless, no daemon)

| Platform | Install |
|---|---|
| macOS (Intel & Apple Silicon) | `brew install podman podman-compose` then `podman machine init && podman machine start` |
| Fedora / RHEL / CentOS Stream | `sudo dnf install -y podman podman-compose` |
| Debian / Ubuntu | `sudo apt-get install -y podman` then `pip install podman-compose` (or `pipx install podman-compose`) |
| Windows 10/11 | Install [Podman Desktop](https://podman-desktop.io) **or** enable WSL2 (`wsl --install`) and install Podman inside the distro |

Verify:
```bash
podman --version          # Podman 4.x or later recommended
podman-compose --version  # 1.x or later
```

> **macOS only:** The `podman machine` VM must be running before you use `podman-compose`.
> Run it once: `podman machine init && podman machine start`.
> Subsequent starts only need `podman machine start` (or it starts automatically on newer versions).

### Node.js (without Podman — local development only)

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

### Option A: Podman (recommended)

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

# Manual (any platform)
podman-compose -f podman-compose.yml up --build
```

The application will be available at **http://localhost:4000**.

---

### Option B: Without Podman (local Node.js)

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

Podman on macOS runs containers inside a lightweight Linux VM (`podman machine`).
The VM is multi-arch and natively supports `linux/arm64` — no Rosetta emulation needed.

```bash
# One-time machine setup
podman machine init
podman machine start

# Then use the normal start script
./start.sh
```

### Windows

**Option A — Podman Desktop (native Windows):**
Install [Podman Desktop](https://podman-desktop.io) and use `start.bat` or `.\start.ps1`.
`start.ps1` detects a native Podman install automatically.

**Option B — WSL2:**
```powershell
# Enable WSL2 (Administrator PowerShell, then restart)
wsl --install
```
Inside the WSL2 distro:
```bash
sudo apt-get update && sudo apt-get install -y podman
pip install podman-compose
systemctl --user enable --now podman.socket
```
Then run `./start.sh` from a WSL2 terminal.
`start.ps1` and `start.bat` auto-detect WSL2 and delegate to it if native Podman is not found.

If you see a PowerShell execution policy error:
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### Linux

Rootless Podman works natively without a daemon.
To activate the user socket (needed by `DOCKER_HOST` compatibility shim):
```bash
systemctl --user enable --now podman.socket
```

`start.sh` exports `DOCKER_HOST` pointing at the rootless Podman socket automatically
so that `podman-compose` can locate it even if `DOCKER_HOST` is not set in your shell.

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
podman-compose -f podman-compose.yml ps

# View application logs
podman-compose -f podman-compose.yml logs -f
```

---

## Upgrading

```bash
git pull
./stop.sh        # or .\stop.ps1
./start.sh       # or .\start.ps1
```

The `--build` flag in `start.sh` ensures the container image is rebuilt with the
latest source.

---

## Uninstalling

```bash
# Stop containers and remove named volumes (deletes all backup data)
podman-compose -f podman-compose.yml down -v

# Remove the container image
podman rmi jira-workload:latest
```

---

## Troubleshooting

| Symptom | Solution |
|---|---|
| Server fails to start | Verify all required env vars are set in `.env`; run `podman-compose -f podman-compose.yml logs app` to see the startup error |
| `OAUTH_TOKEN_ENCRYPTION_KEY` invalid | Must be exactly 64 hex characters; regenerate with `openssl rand -hex 32` (macOS/Linux) or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| OAuth redirect mismatch error | `ATLASSIAN_REDIRECT_URI` in `.env` must **exactly** match the Redirect URI registered in the Atlassian Developer Console — no trailing slash |
| Webhooks not receiving events | Set `WEBHOOK_CALLBACK_URL` to a publicly reachable HTTPS URL; use [ngrok](https://ngrok.com) (`ngrok http 4000`) for local development |
| Port 4000 already in use | Set `PORT=4001` (or any free port) in `.env`; the Podman port mapping updates automatically |
| `permission denied` running `start.sh` on Linux/macOS | Run `chmod +x start.sh stop.sh healthcheck.sh` then retry |
| Container exits immediately after start | Run `podman-compose -f podman-compose.yml logs app` — most commonly a missing or malformed env var; compare your `.env` against `.env.example` |
| Podman machine not running (macOS) | Run `podman machine start` then retry `./start.sh` |
| `podman-compose: command not found` | Install with `pip install podman-compose` or `pipx install podman-compose` |
| Backup data lost after restart | Use `podman-compose -f podman-compose.yml down` **without** the `-v` flag to preserve named volumes; `-v` permanently deletes all backup data |
| `ECONNREFUSED` connecting to Jira API | Confirm your Atlassian OAuth app has the correct scopes and the `ATLASSIAN_CLIENT_ID` / `ATLASSIAN_CLIENT_SECRET` values are not swapped |
| Linux: `podman-compose` cannot find socket | Run `systemctl --user enable --now podman.socket`, then ensure `XDG_RUNTIME_DIR` is set (`echo $XDG_RUNTIME_DIR`) |
