# ADR-HTTPS-001 — HTTPS Redirect URI Requirement for Atlassian OAuth 2.0 (3LO)

_Author: software_architect | Date: 2026-05-01 | Status: **Accepted**_

---

## Context

### Problem Statement

When a developer runs the jira_workload stack locally and clicks **Connect to Atlassian**,
the OAuth 2.0 authorization redirect fails with:

```
Redirect URI must be a valid HTTPS URL
```

The authorization request is rejected before the Atlassian consent screen is shown.
The local stack (introduced in Sprint 7/8 using Podman Compose) exposes the application
on `http://localhost:4000`, and the `.env.example` defaults to:

```dotenv
ATLASSIAN_REDIRECT_URI=http://localhost:4000/oauth/callback
```

### Root Cause

Atlassian's OAuth 2.0 (3LO) platform **enforces HTTPS for all registered callback URLs**
in the Atlassian Developer Console. This enforcement has two independent layers:

1. **Developer Console validation** — when you register the callback URL in
   [developer.atlassian.com/console/myapps/](https://developer.atlassian.com/console/myapps/),
   the form rejects any URL that does not begin with `https://`. You cannot save an
   `http://` callback URL at all (the save button either stays disabled or shows an
   inline error).

2. **Runtime authorization request validation** — even if a callback URL somehow
   reached the authorization server, Atlassian's authorization server (`auth.atlassian.com`)
   validates the `redirect_uri` parameter in the incoming request against the registered
   callback URLs and rejects non-HTTPS values with the error above.

Atlassian's rationale is the OAuth 2.0 Security Best Current Practice (RFC 9700) and the
original RFC 6749 §3.1.2.1 recommendation that redirect endpoints MUST use TLS in
production. Unlike some providers (e.g. Google, GitHub) that grant a localhost HTTP
exemption per RFC 8252 (OAuth 2.0 for Native Apps), **Atlassian Cloud does not expose
a localhost HTTP exemption for their 3LO app type** as of 2026. The connector app type
used by jira_workload is categorized as a server-side web app, not a native app, so the
RFC 8252 exemption does not apply.

### Affected Flows

- Express OAuth path: `POST /api/v1/oauth/express/redirect` → browser redirect to Atlassian
- Manual OAuth path: user-supplied Redirect URI must also be HTTPS for the same reason

---

## Decision Drivers

- **Zero code changes preferred** — the existing application code, routes, and Podman
  Compose definition should require minimal modification.
- **Works offline or with restricted corporate networks** — ngrok tunnels traverse firewalls
  but require internet; local TLS solutions work fully offline.
- **Reproducible across the team** — the solution must be documentable as a single set of
  steps that any developer can follow on macOS, Linux, or Windows.
- **Does not require OS-level trust store modifications in production** — the TLS approach
  must not bleed into the container image.

---

## Considered Solutions

### Option A — ngrok Tunnel (Recommended)

**What it is:** ngrok is a reverse proxy that creates a publicly accessible HTTPS URL
(`https://<random>.ngrok-free.app`) that tunnels to `http://localhost:4000`.

**How it works for this project:**

```
Atlassian → https://<id>.ngrok-free.app/oauth/callback
               → ngrok agent (local process)
               → http://localhost:4000/oauth/callback
               → jira_workload backend (Podman container)
```

**Setup steps (one-time per developer):**

1. [Sign up for a free ngrok account](https://ngrok.com) and install the CLI:
   ```bash
   # macOS
   brew install ngrok
   # Linux
   curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
   # Windows: download from ngrok.com or: winget install ngrok
   ```
2. Authenticate the CLI: `ngrok config add-authtoken <your-token>`
3. Start the tunnel (while the Podman stack is running):
   ```bash
   ngrok http 4000
   ```
4. Copy the HTTPS forwarding URL shown (e.g. `https://abc123.ngrok-free.app`).
5. In the Atlassian Developer Console → **Authorization** → **Callback URLs**, add:
   ```
   https://abc123.ngrok-free.app/oauth/callback
   ```
6. Update `.env`:
   ```dotenv
   ATLASSIAN_REDIRECT_URI=https://abc123.ngrok-free.app/oauth/callback
   ```
7. Restart the Podman stack: `./start.sh` (or `.\start.ps1` on Windows).

**Trade-offs:**

| | |
|---|---|
| ✅ Zero changes to application code or Podman Compose | |
| ✅ Terminates TLS at the ngrok edge — no cert management | |
| ✅ Works through corporate firewalls (ngrok uses outbound connections) | |
| ✅ Free tier is sufficient for OAuth flows | |
| ❌ Requires internet access during the OAuth flow | |
| ❌ Free tier URL changes every time `ngrok http` is restarted (must update Atlassian Console) | |
| ❌ Requires creating an ngrok account | |
| ❌ ngrok agent is a third-party process that sees plaintext traffic at `localhost` | |

**Stable URL (optional):** ngrok paid plans offer custom subdomains (e.g.
`https://my-jira-workload.ngrok.app`) that persist across restarts, eliminating the
need to update the Atlassian Console on each session.

---

### Option B — Caddy Reverse Proxy Sidecar (Podman Compose Integration)

**What it is:** Caddy is a lightweight web server with automatic HTTPS via Let's Encrypt
or a local CA. For local development without a public domain, `mkcert` generates a
locally-trusted certificate that Caddy serves. The Caddy container sits in front of the
jira_workload container and terminates TLS.

**How it works for this project:**

```
Atlassian → https://localhost:4443/oauth/callback
               → Caddy container (TLS termination, local cert)
               → http://app:4000/oauth/callback  (internal Podman network)
               → jira_workload backend container
```

**Setup steps:**

1. Install `mkcert` and create a local CA + certificate:
   ```bash
   # macOS
   brew install mkcert && mkcert -install
   mkcert localhost 127.0.0.1 ::1
   # Linux
   sudo apt install mkcert && mkcert -install
   mkcert localhost 127.0.0.1 ::1
   # Windows (elevated PowerShell)
   choco install mkcert; mkcert -install
   mkcert localhost 127.0.0.1 ::1
   ```
   This generates `localhost+2.pem` and `localhost+2-key.pem` — copy them to `certs/`.

2. Add a `Caddyfile` to the project root:
   ```
   https://localhost:4443 {
       tls /certs/localhost+2.pem /certs/localhost+2-key.pem
       reverse_proxy app:4000
   }
   ```

3. Add a Caddy service to `podman-compose.yml` (see existing file):
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

4. Register `https://localhost:4443/oauth/callback` in the Atlassian Developer Console.

5. Update `.env`:
   ```dotenv
   ATLASSIAN_REDIRECT_URI=https://localhost:4443/oauth/callback
   ```

**Trade-offs:**

| | |
|---|---|
| ✅ Works fully offline — no internet required after initial image pull | |
| ✅ Stable URL (`localhost:4443`) — no need to update Atlassian Console on each restart | |
| ✅ Reproducible: `Caddyfile` and cert generation steps are committed | |
| ✅ No third-party tunnel service sees traffic | |
| ❌ Requires `mkcert -install` on each developer machine (modifies OS trust store) | |
| ❌ Adds a container to the Podman Compose stack (minor complexity increase) | |
| ❌ `certs/` directory must be gitignored to avoid committing private keys | |
| ❌ Does not provide a public HTTPS URL — cannot be used for production callbacks | |

---

### Option C — Cloudflare Tunnel (cloudflared)

Similar to ngrok but uses Cloudflare's edge. Provides a stable custom subdomain on
a registered domain. Requires a Cloudflare account and a domain name. More setup
overhead than ngrok for local dev; better suited for persistent staging environments.
Not evaluated further here.

---

## Decision

**Recommended solution: Option A (ngrok) as the primary path, with Option B (Caddy)
documented as the offline/advanced alternative.**

### Justification

1. **Zero stack changes** — ngrok requires no modifications to `podman-compose.yml`,
   `Dockerfile`, or application source code. A developer can be unblocked in under
   5 minutes from a clean clone.

2. **Universal compatibility** — ngrok's outbound connection model works on corporate
   networks that block inbound connections (common for engineering teams). Caddy's
   sidecar works great but `mkcert -install` involves OS-level trust store changes that
   some corporate MDM policies block on managed machines.

3. **Scope of the problem** — the HTTPS callback constraint is a local-dev onboarding
   friction point, not a production architecture gap. A lightweight solution (ngrok) is
   appropriate; over-engineering (custom CA infrastructure) is not justified.

4. **Production path is unaffected** — in any real deployment the backend sits behind a
   TLS-terminating load balancer or reverse proxy (nginx, Caddy, Traefik). The
   `ATLASSIAN_REDIRECT_URI` is set to the production `https://` URL. The ngrok shim is
   purely a local-dev affordance.

---

## Consequences

### Immediate Actions

- Update `OAUTH_SETUP.md` to add an explicit **Section 2a — Local HTTPS Workaround**
  covering ngrok setup (Option A) and the Caddy alternative (Option B).
- Update `.env.example` comment to clarify that `http://localhost` will be rejected by
  Atlassian and guide developers to use the HTTPS workaround.
- Add `certs/` to `.gitignore` as a precaution for teams that adopt Option B.

### Non-Actions (Explicitly Out of Scope)

- **No changes to `ATLASSIAN_REDIRECT_URI` default value** — the `http://localhost:4000`
  default is kept as a self-documenting placeholder that clearly shows the port; the
  comment above it is updated to explain the HTTPS requirement.
- **No changes to the application's OAuth route handlers** — the backend is agnostic to
  whether the incoming callback arrives over HTTP or HTTPS; the TLS is terminated upstream.
- **No self-signed cert generation in the Dockerfile or start scripts** — this would
  bake certificate material into the image or repository.

---

## References

- RFC 6749 §3.1.2.1 — Endpoint Request Confidentiality
- RFC 9700 — OAuth 2.0 Security Best Current Practice
- RFC 8252 — OAuth 2.0 for Native Apps (localhost exemption, does not apply here)
- Atlassian Developer Console → OAuth 2.0 (3LO) callback URL requirements
- Sprint 7 / Sprint 8 — Podman deployment stack (`podman-compose.yml`, `start.sh`)
- `docs/architecture/oauth-architecture.md` — Express and Manual OAuth path sequence diagrams
