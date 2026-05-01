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
# ⚠ Must be HTTPS — see OAUTH_SETUP.md § 2a for ngrok / Caddy setup
ATLASSIAN_REDIRECT_URI=https://<your-ngrok-id>.ngrok-free.app/oauth/callback
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

## Atlassian App Registration & OAuth Setup

### Why you need an HTTPS redirect URI

Atlassian's OAuth 2.0 (3LO) platform **requires all callback URLs to use HTTPS** —
including during local development. If `ATLASSIAN_REDIRECT_URI` in `.env` starts
with `http://` you will see this error when you click **Connect to Atlassian**:

```
Redirect URI must be a valid HTTPS URL
```

The Atlassian Developer Console also refuses to save any `http://` callback URL.
You must use one of the HTTPS workarounds below before registering the app.

---

### Step 1 — Choose a local HTTPS approach

#### Option A — ngrok (recommended)

ngrok provides a publicly accessible `https://` URL that tunnels to your local
Podman/Node.js server. No changes to the application or Podman Compose are required.

```bash
# Install ngrok
brew install ngrok                 # macOS
winget install ngrok.ngrok         # Windows
# Linux: see https://ngrok.com/download for the apt/yum instructions

# Authenticate (one-time)
ngrok config add-authtoken <your-ngrok-auth-token>

# Start your Podman stack first, then in a second terminal:
ngrok http 4000
# Output: Forwarding  https://abc123.ngrok-free.app -> http://localhost:4000
```

Your redirect URI is:

```
https://abc123.ngrok-free.app/oauth/callback
```

> **Note:** The free-tier URL changes each time you restart `ngrok http 4000`.
> When it changes, update the callback URL in both `.env` and the Atlassian Developer
> Console. ngrok paid plans offer a stable custom subdomain.

#### Option B — Caddy + mkcert (offline / stable URL)

If you need a stable `https://localhost:4443` URL that works without internet access:

```bash
# Install mkcert and create a local CA + certificate
brew install mkcert && mkcert -install  # macOS
sudo apt install mkcert && mkcert -install  # Linux
choco install mkcert && mkcert -install     # Windows (elevated PowerShell)

mkcert localhost 127.0.0.1 ::1
mkdir -p certs
mv localhost+2.pem certs/
mv localhost+2-key.pem certs/
```

Copy `Caddyfile.example` to `Caddyfile` in the project root (already contains the
correct configuration), then add the Caddy service to `podman-compose.yml`:

```yaml
  caddy:
    image: caddy:2-alpine
    ports:
      - "4443:4443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./certs:/certs:ro
    depends_on:
      - app
```

Your redirect URI is:

```
https://localhost:4443/oauth/callback
```

---

### Step 2 — Register the app in the Atlassian Developer Console

1. Go to [developer.atlassian.com/console/myapps/](https://developer.atlassian.com/console/myapps/)
2. Click **Create** → **OAuth 2.0 integration**
3. Enter an app name (e.g. `jira-workload-local`) → **Create**
4. Open the **Authorization** tab → **OAuth 2.0 (3LO)** → click **Add** next to **Callback URL**
5. Paste your HTTPS redirect URI from Step 1:

   **ngrok:**
   ```
   https://abc123.ngrok-free.app/oauth/callback
   ```

   **Caddy:**
   ```
   https://localhost:4443/oauth/callback
   ```

6. Click **Save changes**

---

### Step 3 — Add required scopes

1. Open the **Permissions** tab
2. Add all required Jira API scopes — see [OAUTH_SETUP.md §3](../OAUTH_SETUP.md) for the
   full scope list
3. Click **Save**

---

### Step 4 — Copy credentials to `.env`

1. Open the **Settings** tab → copy **Client ID** and **Client Secret**
2. Set in `.env`:

   ```dotenv
   ATLASSIAN_CLIENT_ID=<paste Client ID here>
   ATLASSIAN_CLIENT_SECRET=<paste Client Secret here>
   ATLASSIAN_REDIRECT_URI=https://abc123.ngrok-free.app/oauth/callback
   ```

   The `ATLASSIAN_REDIRECT_URI` value must **exactly match** the Callback URL registered
   in the Atlassian Developer Console — same scheme, host, port, and path; no trailing slash.

3. Restart the Podman stack after saving `.env`:
   ```bash
   ./stop.sh && ./start.sh     # macOS / Linux
   .\stop.ps1; .\start.ps1     # Windows PowerShell
   ```

See [OAUTH_SETUP.md](../OAUTH_SETUP.md) for the complete reference including all scopes,
the token encryption key generation command, and default threshold values.

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
| `Redirect URI must be a valid HTTPS URL` | `ATLASSIAN_REDIRECT_URI` starts with `http://` — Atlassian requires HTTPS for all callback URLs, including local development. Set `ATLASSIAN_REDIRECT_URI` to an ngrok or Caddy HTTPS URL — see **Atlassian App Registration & OAuth Setup** above |
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
