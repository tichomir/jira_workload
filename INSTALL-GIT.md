# INSTALL-GIT.md — Git-Based Install & Upgrade Guide

This guide covers installing jira_workload by cloning the source repository and
upgrading without merge conflicts.  It solves the `podman-compose.override.yml`
pattern that prevents `git pull` from ever overwriting your local settings.

> **Looking for the container-registry install (no git clone required)?**
> See **[INSTALL-CONTAINER.md](INSTALL-CONTAINER.md)**.

---

## Prerequisites

| Tool | Minimum version | Install |
|---|---|---|
| git | any | usually pre-installed |
| Podman | 4.x | `brew install podman` (macOS) · `dnf install podman` (Fedora/RHEL) · `apt install podman` (Debian/Ubuntu) |
| podman-compose | 1.x | `pip install podman-compose` or `pipx install podman-compose` |

Verify:
```bash
git --version
podman --version
podman-compose --version
```

> **macOS only:** initialise the Podman VM once before anything else:
> ```bash
> podman machine init && podman machine start
> ```

---

## Why the Override Pattern?

`podman-compose.yml` is tracked in git.  The moment you edit it to, for example,
enable the Caddy sidecar or change the port, you create a local modification that
blocks every future `git pull`:

```
error: Your local changes to the following files would be overwritten by merge:
        podman-compose.yml
Please commit your changes or stash them before you merge.
Aborting
```

**The fix:** keep `podman-compose.yml` untouched.  Put all your local tweaks in
`podman-compose.override.yml` (listed in `.gitignore`).  Podman Compose merges
both files at start-up — your customisations are applied but are never tracked by
git, so `git pull` runs cleanly every time.

---

## First-Time Install

### Step 1 — Clone the repository

```bash
git clone <repository-url>
cd jira_workload
```

### Step 2 — Create your environment file

```bash
# macOS / Linux
cp .env.example .env

# Windows CMD
copy .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

Open `.env` and fill in the four required values:

```dotenv
ATLASSIAN_CLIENT_ID=<from Atlassian Developer Console>
ATLASSIAN_CLIENT_SECRET=<from Atlassian Developer Console>
ATLASSIAN_REDIRECT_URI=https://<your-ngrok-or-caddy-url>/oauth/callback
OAUTH_TOKEN_ENCRYPTION_KEY=<64 hex chars — see generation command below>
```

Generate an encryption key (run once, paste the output into `.env`):

```bash
# macOS / Linux
openssl rand -hex 32

# Node.js (any platform)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Windows PowerShell
-join ((1..32) | % { '{0:x2}' -f (Get-Random -Max 256) })
```

> **HTTPS callback URL required.**  Atlassian refuses `http://` redirect URIs.
> See [OAUTH_SETUP.md](OAUTH_SETUP.md) for the ngrok (recommended) and
> Caddy + mkcert (offline) options.

### Step 3 — Create your compose override file

```bash
# macOS / Linux
cp podman-compose.override.yml.example podman-compose.override.yml

# Windows CMD
copy podman-compose.override.yml.example podman-compose.override.yml

# Windows PowerShell
Copy-Item podman-compose.override.yml.example podman-compose.override.yml
```

Open `podman-compose.override.yml` and uncomment only what you need (port
changes, Caddy sidecar, custom volume paths, etc.).  Everything is commented out
by default — an empty override file is perfectly valid.

### Step 4 — Start the stack

```bash
# macOS / Linux (recommended)
./start.sh

# Windows PowerShell
.\start.ps1

# Windows CMD
start.bat

# Manual — any platform
podman-compose -f podman-compose.yml -f podman-compose.override.yml up --build -d
```

The app is available at **http://localhost:4000**.

Verify it is healthy:
```bash
curl http://localhost:4000/health
# Expected: {"status":"ok"}
```

---

## Upgrading

> **Your data is safe.** OAuth connections, backup metadata, and all user-generated
> state live in named Podman volumes (`db_data`, `backup_data`, etc.) that are
> never touched by a `git pull` or image rebuild.

### Before your first pull — one-time migration (if you edited podman-compose.yml directly)

If you already have a local modification to `podman-compose.yml` you will see:

```
error: Your local changes to the following files would be overwritten by merge:
        podman-compose.yml
Please commit your changes or stash them before you merge.
Aborting
```

Fix it once, then you will never see it again:

```bash
# 1. See what you changed
git diff podman-compose.yml

# 2. Copy your changes into the override file
#    (re-apply them as uncommented stubs in podman-compose.override.yml)

# 3. Discard the tracked file's local modification
git checkout -- podman-compose.yml

# 4. Confirm the file is clean
git status podman-compose.yml
# Expected: nothing to commit

# 5. Now pull cleanly
git pull
```

### Normal upgrade (after the one-time migration above)

```bash
# 1. Verify no tracked files have local changes
git status
# Expected: nothing to commit (or only untracked files — those are safe)

# 2. Pull the latest source
git pull

# 3. Stop the running stack (does NOT remove volumes)
./stop.sh          # macOS / Linux
.\stop.ps1         # Windows PowerShell

# 4. Rebuild and restart with your override applied
./start.sh         # macOS / Linux  (runs with --build automatically)
.\start.ps1        # Windows PowerShell

# Manual equivalent
podman-compose -f podman-compose.yml -f podman-compose.override.yml up --build -d
```

### Upgrade checklist

- [ ] `git status` shows no tracked files with local modifications
- [ ] `git pull` completes without errors
- [ ] Stack stopped with `./stop.sh` (no `-v` — that would wipe data)
- [ ] Stack restarted with `./start.sh` (or the manual command above)
- [ ] `curl http://localhost:4000/health` returns `{"status":"ok"}`
- [ ] Open http://localhost:4000 and confirm your connections are still present

---

## Making Local Customisations

All local tweaks go in `podman-compose.override.yml` (already gitignored).
The example file `podman-compose.override.yml.example` contains commented stubs
for the most common scenarios.

### Change the port

```yaml
# podman-compose.override.yml
services:
  app:
    ports:
      - "4001:4000"
```

### Enable the Caddy HTTPS sidecar

```yaml
# podman-compose.override.yml
services:
  caddy:
    image: caddy:2-alpine
    ports:
      - "4443:4443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./certs:/certs:ro
    depends_on:
      - app
    restart: unless-stopped
```

See [OAUTH_SETUP.md](OAUTH_SETUP.md) § 2a Option B for the mkcert certificate
generation steps required before enabling Caddy.

### Use a custom data directory

```yaml
# podman-compose.override.yml
services:
  app:
    volumes:
      - /mnt/external/jira-workload:/data
```

---

## Files That Are Gitignored (never cause merge conflicts)

| File | Purpose |
|---|---|
| `.env` | Your Atlassian credentials and encryption key |
| `podman-compose.override.yml` | Your local port/service/volume customisations |
| `certs/` | mkcert-generated TLS certificates |

---

## Troubleshooting

### `Your local changes to the following files would be overwritten by merge`

This means you edited a tracked file (`podman-compose.yml`, or another source
file) directly.

```bash
# See which files are affected
git status

# Option A — move changes to the override file, then discard the tracked edit
git diff podman-compose.yml          # note what you changed
git checkout -- podman-compose.yml   # discard the tracked edit
# re-apply the change in podman-compose.override.yml instead
git pull

# Option B — stash everything, pull, then pop
git stash
git pull
git stash pop
# resolve any conflicts manually, then move edits to the override file
```

After following Option A or B, copy anything you customised from
`podman-compose.yml` into `podman-compose.override.yml` so the same situation
cannot recur.

### `git pull` succeeds but the app won't start after upgrade

```bash
# Check container logs for startup errors
podman-compose -f podman-compose.yml -f podman-compose.override.yml logs -f app

# Most common cause: new required env var added in .env.example
# Compare your .env against the example
diff .env.example .env
```

Add any new variables from `.env.example` to your `.env`, then restart.

### Connections disappeared after upgrade

You ran `podman-compose down -v` at some point.  The `-v` flag removes named
volumes and **permanently deletes** `db.json`.

Going forward, always stop with:
```bash
./stop.sh               # macOS / Linux (never passes -v)
.\stop.ps1              # Windows PowerShell
# or manually:
podman-compose -f podman-compose.yml -f podman-compose.override.yml down
```

Never add `-v` unless you intend to wipe all data.

### `podman-compose logs -f` shows no output

The stack was started without the override file, which omits the `json-file`
logging driver override.  Restart with:
```bash
./stop.sh
./start.sh
```
or with the explicit two-file command shown in the Upgrade section.

### Port already in use

Set a different port in `podman-compose.override.yml`:
```yaml
services:
  app:
    ports:
      - "4001:4000"
```
And update `APP_BASE_URL` / `FRONTEND_BASE_URL` in `.env` to match.

---

## Related Guides

| Guide | Content |
|---|---|
| [INSTALL-CONTAINER.md](INSTALL-CONTAINER.md) | Container-registry install (no git clone), upgrade, rollback, version pinning |
| [OAUTH_SETUP.md](OAUTH_SETUP.md) | HTTPS callback URL setup (ngrok / Caddy), scope list |
| [README.md](README.md) | Project overview and feature summary |
