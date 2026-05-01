'use strict';

/**
 * env.js — Environment variable validation and typed constants.
 *
 * Imported once at application startup (required by src/app.js or src/server.js).
 * Throws a descriptive Error immediately if any required variable is missing or
 * invalid, preventing the server from starting with a broken configuration.
 *
 * All exported constants should be consumed from this module instead of reading
 * process.env directly — this gives a single authoritative source of truth and
 * makes misconfiguration visible at boot rather than at runtime.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the value of an environment variable.
 * Throws if required and not set (or empty string).
 *
 * @param {string} name        - Environment variable name.
 * @param {object} [options]
 * @param {boolean} [options.required=false] - Throw if not set.
 * @param {string}  [options.defaultValue]   - Fallback when not required and unset.
 * @returns {string|undefined}
 */
function get(name, { required = false, defaultValue } = {}) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (required) {
      throw new Error(
        `[env] Required environment variable "${name}" is not set. ` +
        `See config/deployment.env.example for documentation.`
      );
    }
    return defaultValue;
  }
  return value;
}

/**
 * Return an integer env var, throwing if the value is not a valid integer.
 *
 * @param {string} name
 * @param {object} [options]
 * @param {boolean} [options.required=false]
 * @param {number}  [options.defaultValue]
 * @returns {number|undefined}
 */
function getInt(name, { required = false, defaultValue } = {}) {
  const raw = get(name, { required: required && defaultValue === undefined });
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `[env] Environment variable "${name}" must be an integer, got: "${raw}"`
    );
  }
  return parsed;
}

/**
 * Return a boolean env var.  Only the string 'true' (case-insensitive) maps
 * to true; anything else maps to false.
 *
 * @param {string} name
 * @param {object} [options]
 * @param {boolean} [options.defaultValue=false]
 * @returns {boolean}
 */
function getBool(name, { defaultValue = false } = {}) {
  const raw = get(name);
  if (raw === undefined) return defaultValue;
  return raw.toLowerCase() === 'true';
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate that OAUTH_TOKEN_ENCRYPTION_KEY is exactly 64 hex characters (32 bytes).
 * Called during module initialisation — throws on invalid format.
 */
function validateEncryptionKey(value) {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(
      '[env] OAUTH_TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
}

// ---------------------------------------------------------------------------
// Required variables (server will not start if these are missing)
// ---------------------------------------------------------------------------

const ATLASSIAN_CLIENT_ID = get('ATLASSIAN_CLIENT_ID', { required: true });
const ATLASSIAN_CLIENT_SECRET = get('ATLASSIAN_CLIENT_SECRET', { required: true });
const ATLASSIAN_REDIRECT_URI = get('ATLASSIAN_REDIRECT_URI', { required: true });
const OAUTH_TOKEN_ENCRYPTION_KEY = get('OAUTH_TOKEN_ENCRYPTION_KEY', { required: true });

// Validate encryption key format immediately at startup.
validateEncryptionKey(OAUTH_TOKEN_ENCRYPTION_KEY);

// ---------------------------------------------------------------------------
// Optional variables with documented defaults
// ---------------------------------------------------------------------------

const PORT = getInt('PORT', { defaultValue: 4000 });
const NODE_ENV = get('NODE_ENV', { defaultValue: 'development' });
const APP_BASE_URL = get('APP_BASE_URL', { defaultValue: 'http://localhost:4000' });
const FRONTEND_BASE_URL = get('FRONTEND_BASE_URL', { defaultValue: APP_BASE_URL });
const OAUTH_STATE_TTL_SECONDS = getInt('OAUTH_STATE_TTL_SECONDS', { defaultValue: 600 });
const INTEGRATION_SOFT_DELETE_RETENTION_DAYS = getInt('INTEGRATION_SOFT_DELETE_RETENTION_DAYS', { defaultValue: 30 });
const ALLOW_HARD_DELETE = getBool('ALLOW_HARD_DELETE', { defaultValue: false });

// Webhook callback URL: explicit env var takes precedence, otherwise derived from APP_BASE_URL.
const WEBHOOK_CALLBACK_URL = get('WEBHOOK_CALLBACK_URL', {
  defaultValue: `${APP_BASE_URL}/webhooks/jira`,
});

// Persistent data directory — stores db.json (connections, backup metadata, etc.).
// Defaults to ~/.dcc-jira for local development; set to /data inside containers.
// See src/db/persist.js for the full resolution order.
const DATA_DIR = get('DATA_DIR', { defaultValue: '' }); // empty → persist.js uses os.homedir()

// Storage paths — use forward slashes; Node.js path.join normalises on all platforms.
const BACKUP_STORAGE_PATH = get('BACKUP_STORAGE_PATH', { defaultValue: './data/backups' });
const SDI_TMP_PATH = get('SDI_TMP_PATH', { defaultValue: './data/sdi-tmp' });
const EXPORT_ARCHIVE_PATH = get('EXPORT_ARCHIVE_PATH', { defaultValue: './data/exports' });

// Database (reserved — currently using in-memory store).
const DATABASE_URL = get('DATABASE_URL');
const DATABASE_POOL_SIZE = getInt('DATABASE_POOL_SIZE', { defaultValue: 10 });

// Job timeout — maximum number of minutes a backup/restore job may run without
// emitting a heartbeat before it is force-failed by the timeout guard.
// Default: 120 minutes. Set to a lower value in dev/test environments.
const JOB_TIMEOUT_MINUTES = getInt('JOB_TIMEOUT_MINUTES', { defaultValue: 120 });

// ---------------------------------------------------------------------------
// Safety guard: Hard Delete must never be enabled in production.
// ---------------------------------------------------------------------------

if (NODE_ENV === 'production' && ALLOW_HARD_DELETE) {
  throw new Error(
    '[env] ALLOW_HARD_DELETE=true is not permitted when NODE_ENV=production. ' +
    'Hard Delete is a sandbox-only feature.'
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Server
  PORT,
  NODE_ENV,

  // Atlassian OAuth
  ATLASSIAN_CLIENT_ID,
  ATLASSIAN_CLIENT_SECRET,
  ATLASSIAN_REDIRECT_URI,

  // Application URLs
  APP_BASE_URL,
  FRONTEND_BASE_URL,

  // Token security
  OAUTH_TOKEN_ENCRYPTION_KEY,

  // OAuth state
  OAUTH_STATE_TTL_SECONDS,

  // Integration lifecycle
  INTEGRATION_SOFT_DELETE_RETENTION_DAYS,
  ALLOW_HARD_DELETE,

  // Webhooks
  WEBHOOK_CALLBACK_URL,

  // Persistent data directory
  DATA_DIR,

  // Storage paths
  BACKUP_STORAGE_PATH,
  SDI_TMP_PATH,
  EXPORT_ARCHIVE_PATH,

  // Database (reserved)
  DATABASE_URL,
  DATABASE_POOL_SIZE,

  // Job timeout guard
  JOB_TIMEOUT_MINUTES,
};
