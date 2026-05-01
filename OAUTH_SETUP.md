# OAuth Setup Guide — Atlassian OAuth 2.0 (3LO)

This guide explains how to register an Atlassian OAuth 2.0 app, configure the redirect URI,
and copy the required credentials into your local environment.

---

## 1. Register an Atlassian OAuth 2.0 App

1. Go to the [Atlassian Developer Console](https://developer.atlassian.com/console/myapps/).
2. Click **Create** → **OAuth 2.0 integration**.
3. Enter an app name (e.g. `jira-workload-local`) and accept the terms.
4. Click **Create**.

---

## 2. Configure the Redirect URI

1. In your new app, open the **Authorization** tab.
2. Under **OAuth 2.0 (3LO)**, click **Add** next to **Callback URL**.
3. Enter your redirect URI:
   - **Local development:** see **Section 2a** below — Atlassian requires an HTTPS URL.
   - **Production:** the HTTPS URL of your deployed callback endpoint (e.g. `https://your-domain.com/oauth/callback`).
4. Click **Save changes**.

---

## 2a. Local Development — HTTPS Workaround

### Why is this required?

Atlassian's OAuth 2.0 (3LO) platform **requires all callback URLs to use HTTPS** —
including during local development. The Atlassian Developer Console will reject any
`http://` callback URL and will not save it. If you attempt to use an `http://localhost`
redirect URI you will see:

```
Redirect URI must be a valid HTTPS URL
```

This error occurs before the Atlassian consent screen is shown. See
[`docs/decisions/adr-https-callback.md`](docs/decisions/adr-https-callback.md) for the
full root-cause analysis and the trade-off evaluation that led to the recommendation below.

---

### Option A — ngrok (Recommended, quickest to set up)

ngrok creates a publicly accessible `https://` URL that tunnels to your local
Podman/Node.js server. No changes to the application or Podman Compose are required.

**Step 1 — Install and authenticate ngrok**

```bash
# macOS
brew install ngrok

# Linux (Debian/Ubuntu)
curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
  | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null \
  && echo "deb https://ngrok-agent.s3.amazonaws.com buster main" \
  | sudo tee /etc/apt/sources.list.d/ngrok.list \
  && sudo apt update && sudo apt install ngrok

# Windows (PowerShell — requires winget or Chocolatey)
winget install ngrok.ngrok
# or: choco install ngrok
```

Sign up for a free account at [ngrok.com](https://ngrok.com), then authenticate:

```bash
ngrok config add-authtoken <your-ngrok-auth-token>
```

**Step 2 — Start the Podman stack first**

```bash
./start.sh          # macOS / Linux
.\start.ps1         # Windows PowerShell
```

**Step 3 — Start the ngrok tunnel** (in a second terminal)

```bash
ngrok http 4000
```

ngrok will display output like:

```
Forwarding  https://abc123.ngrok-free.app -> http://localhost:4000
```

Copy the `https://...ngrok-free.app` URL.

**Step 4 — Register the callback URL in the Atlassian Developer Console**

1. Go to [developer.atlassian.com/console/myapps/](https://developer.atlassian.com/console/myapps/)
2. Open your app → **Authorization** tab → **Callback URLs**.
3. Add: `https://abc123.ngrok-free.app/oauth/callback`
4. Click **Save changes**.

**Step 5 — Update `.env`**

```dotenv
ATLASSIAN_REDIRECT_URI=https://abc123.ngrok-free.app/oauth/callback
```

Restart the Podman stack after saving `.env`:

```bash
./stop.sh && ./start.sh          # macOS / Linux
.\stop.ps1; .\start.ps1          # Windows PowerShell
```

> **Note on free tier URLs:** The ngrok URL changes every time you restart the `ngrok http`
> process. When that happens, update the callback URL in both `.env` and the Atlassian
> Developer Console. ngrok paid plans offer stable custom subdomains.

---

### Option B — Caddy + mkcert (Offline / No-account alternative)

If you need an offline solution or prefer not to use a third-party tunnel service, you
can run a local Caddy reverse proxy with a `mkcert`-issued certificate. This gives you a
**stable** `https://localhost:4443` URL that works without internet access after setup.

**Step 1 — Install mkcert and generate a certificate**

```bash
# macOS
brew install mkcert && mkcert -install
mkcert localhost 127.0.0.1 ::1

# Linux
sudo apt install mkcert && mkcert -install
mkcert localhost 127.0.0.1 ::1

# Windows (elevated PowerShell)
choco install mkcert
mkcert -install
mkcert localhost 127.0.0.1 ::1
```

Move the generated `localhost+2.pem` and `localhost+2-key.pem` to a `certs/` folder in
the project root. This folder is gitignored — do not commit certificate files.

```bash
mkdir -p certs
mv localhost+2.pem certs/
mv localhost+2-key.pem certs/
```

**Step 2 — Create a `Caddyfile` in the project root**

```
https://localhost:4443 {
    tls /certs/localhost+2.pem /certs/localhost+2-key.pem
    reverse_proxy app:4000
}
```

**Step 3 — Add Caddy to `podman-compose.yml`**

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

**Step 4 — Register the callback URL in the Atlassian Developer Console**

Add `https://localhost:4443/oauth/callback` as the callback URL in your Atlassian app.

**Step 5 — Update `.env`**

```dotenv
ATLASSIAN_REDIRECT_URI=https://localhost:4443/oauth/callback
```

Restart the Podman stack: `./start.sh`.

---

## 3. Add Required Scopes

1. Open the **Permissions** tab.
2. Add the following Jira API scopes:

   | Scope | Required |
   |---|---|
   | `read:jira-user` | Yes |
   | `read:jira-work` | Yes |
   | `write:jira-work` | Yes |
   | `read:board-scope:jira-software` | Optional (board/sprint data) |
   | *(+ remaining scopes per architecture spec)* | |

3. Click **Save** after adding all scopes.

---

## 4. Copy Credentials to `.env`

1. Open the **Settings** tab of your app.
2. Copy the **Client ID** and **Client Secret** values.
3. In the project root, copy `.env.example` to `.env`:

   ```bash
   cp .env.example .env
   ```

4. Fill in the values:

   ```dotenv
   ATLASSIAN_CLIENT_ID=<paste Client ID here>
   ATLASSIAN_CLIENT_SECRET=<paste Client Secret here>
   # Use your ngrok or Caddy HTTPS URL — see Section 2a above
   ATLASSIAN_REDIRECT_URI=https://<your-ngrok-id>.ngrok-free.app/oauth/callback
   ```

---

## 5. Generate the Token Encryption Key

The service encrypts stored OAuth tokens with AES-256-GCM. Generate a fresh 32-byte key:

```bash
openssl rand -hex 32
```

Paste the output into `.env`:

```dotenv
OAUTH_TOKEN_ENCRYPTION_KEY=<paste generated key here>
```

> **Never commit `.env` or any file containing real secrets to source control.**
> `.env` is listed in `.gitignore`; only `.env.example` (with placeholder values) is committed.

---

## 6. Default Threshold Values

The following variables have correct defaults in `.env.example` and only need to be changed
if your deployment requires different retention or alerting behaviour:

| Variable | Default | Meaning |
|---|---|---|
| `SOFT_DELETE_RETENTION_DAYS` | `30` | Days to retain data after a Soft Delete before permanent removal |
| `REFRESH_TOKEN_EXPIRY_WARN_DAYS` | `10` | Days of advance notice before the inactivity threshold is reached |
| `REFRESH_TOKEN_INACTIVITY_THRESHOLD_DAYS` | `80` | Days of refresh token inactivity that trigger a proactive expiry alert (Atlassian invalidates at 90 days) |

---

## 7. Start the Service

```bash
podman-compose -f podman-compose.yml up
```

Or without Podman (local Node.js):

```bash
npm install
npm start
```
