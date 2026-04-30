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
   - **Local development:** `http://localhost:3000/oauth/callback`
   - **Production:** the HTTPS URL of your deployed callback endpoint.
4. Click **Save changes**.

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
   ATLASSIAN_REDIRECT_URI=http://localhost:3000/oauth/callback
   ```

---

## 5. Generate the Token Encryption Key

The service encrypts stored OAuth tokens with AES-256-GCM. Generate a fresh 32-byte key:

```bash
openssl rand -hex 32
```

Paste the output into `.env`:

```dotenv
TOKEN_ENCRYPTION_KEY=<paste generated key here>
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
docker compose up oauth-service
```

Or without Docker:

```bash
npm install
npm start
```
