'use strict';

/**
 * tokenService.js — OAuth access token lifecycle management.
 *
 * Provides:
 *   - refreshConnectionToken(connectionId)  — calls Atlassian /oauth/token with
 *     grant_type=refresh_token, persists new tokens, handles revocation.
 *   - getValidAccessToken(connectionId)     — proactive refresh when token is
 *     within 5 minutes of expiry; returns the decrypted, valid access token.
 *   - createJiraAxiosInstance(connectionId) — returns an axios instance pre-loaded
 *     with the current Bearer token and a response interceptor that transparently
 *     refreshes and retries once on 401. Concurrent 401s are deduplicated via the
 *     same pending-refresh promise.
 */

const axios = require('axios');
const db = require('../db');
const { decrypt, encrypt } = require('./crypto');

const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ATLASSIAN_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

// Proactive buffer: refresh if token expires within 5 minutes.
const PROACTIVE_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// CloudId freshness window: re-verify against accessible-resources at most once per 24h.
const CLOUD_ID_FRESHNESS_MS = 24 * 60 * 60 * 1000;

// In-flight refresh promises, keyed by connectionId.
// Deduplicates concurrent 401 retries so only one token exchange fires per connection.
const _pendingRefreshes = new Map();

// ---------------------------------------------------------------------------
// refreshConnectionToken
// ---------------------------------------------------------------------------

/**
 * Exchange the stored refresh token for a new access token.
 * Persists the new tokens to the connection record and calls db.saveDb().
 *
 * If Atlassian returns 400 or 401 (refresh token revoked / expired), marks the
 * connection status as 'needs_reauth' and throws an error with code 'AUTH_ERROR'.
 *
 * Concurrent calls for the same connectionId reuse the in-flight promise so
 * only one HTTP exchange fires.
 *
 * @param {string} connectionId
 * @returns {Promise<string>} Decrypted new access token
 */
async function refreshConnectionToken(connectionId) {
  if (_pendingRefreshes.has(connectionId)) {
    return _pendingRefreshes.get(connectionId);
  }

  const refreshPromise = (async () => {
    const connection = db.connections.get(connectionId);
    if (!connection) {
      throw new Error(`Connection not found: ${connectionId}`);
    }

    const clientId = connection.clientId || process.env.ATLASSIAN_CLIENT_ID;
    const clientSecret = connection.clientSecret
      ? decrypt(connection.clientSecret)
      : process.env.ATLASSIAN_CLIENT_SECRET;
    const refreshToken = decrypt(connection.refreshToken);

    let tokenData;
    try {
      const response = await axios.post(ATLASSIAN_TOKEN_URL, {
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      });
      tokenData = response.data;
    } catch (err) {
      const status = err.response && err.response.status;
      if (status === 400 || status === 401) {
        // Refresh token is revoked or invalid — mark connection as needing re-auth.
        connection.status = 'needs_reauth';
        connection.updatedAt = new Date().toISOString();
        db.connections.set(connectionId, connection);
        db.saveDb();

        const authErr = new Error(
          'The Atlassian access token has expired and the refresh token is no longer valid. ' +
          'Please reconnect the integration from the Connections page.'
        );
        authErr.code = 'AUTH_ERROR';
        authErr.connectionId = connectionId;
        throw authErr;
      }
      throw err;
    }

    const { access_token, refresh_token, expires_in } = tokenData;
    const now = new Date();

    connection.accessToken = encrypt(access_token);
    // Atlassian rotates the refresh token on each use under offline_access policy.
    if (refresh_token) {
      connection.refreshToken = encrypt(refresh_token);
    }
    connection.accessTokenExpiresAt = new Date(
      now.getTime() + (expires_in || 3600) * 1000
    ).toISOString();
    connection.refreshTokenLastUsedAt = now.toISOString();
    connection.updatedAt = now.toISOString();
    db.connections.set(connectionId, connection);
    db.saveDb();

    return access_token;
  })();

  _pendingRefreshes.set(connectionId, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    _pendingRefreshes.delete(connectionId);
  }
}

// ---------------------------------------------------------------------------
// getValidAccessToken
// ---------------------------------------------------------------------------

/**
 * Return a valid (non-expired) access token for a connection.
 * If the stored token expires within PROACTIVE_REFRESH_BUFFER_MS, refresh first.
 *
 * @param {string} connectionId
 * @returns {Promise<string>} Decrypted access token
 */
async function getValidAccessToken(connectionId) {
  const connection = db.connections.get(connectionId);
  if (!connection) {
    throw new Error(`Connection not found: ${connectionId}`);
  }

  const expiresAt = connection.accessTokenExpiresAt
    ? new Date(connection.accessTokenExpiresAt).getTime()
    : 0;

  if (expiresAt - Date.now() < PROACTIVE_REFRESH_BUFFER_MS) {
    return refreshConnectionToken(connectionId);
  }

  return decrypt(connection.accessToken);
}

// ---------------------------------------------------------------------------
// createJiraAxiosInstance
// ---------------------------------------------------------------------------

/**
 * Create an axios instance pre-configured for Jira Cloud API requests on behalf
 * of a specific connection. The instance carries the current Bearer token and has
 * a response interceptor that:
 *   1. On 401: calls refreshConnectionToken (deduplicated), updates the header,
 *      and retries the original request exactly once.
 *   2. On second 401 (or AUTH_ERROR during refresh): throws so the calling job
 *      can record an 'auth_error' status instead of a raw AxiosError stack trace.
 *
 * @param {string} connectionId
 * @param {string} initialAccessToken  Already-decrypted token to start with
 * @returns {import('axios').AxiosInstance}
 */
function createJiraAxiosInstance(connectionId, initialAccessToken) {
  const instance = axios.create({
    headers: {
      Authorization: `Bearer ${initialAccessToken}`,
      Accept: 'application/json',
    },
  });

  instance.interceptors.response.use(
    null,
    async (error) => {
      const config = error.config;
      if (error.response && error.response.status === 401) {
        if (!config._retried) {
          config._retried = true;
          // refreshConnectionToken is deduplicated — concurrent 401s share one exchange.
          const newToken = await refreshConnectionToken(connectionId);
          config.headers['Authorization'] = `Bearer ${newToken}`;
          return instance(config);
        }
        // Retry also returned 401 — token is permanently invalid; surface AUTH_ERROR.
        const authErr = new Error(
          'Atlassian rejected both the original and refreshed access token. ' +
          'Please reconnect the integration from the Connections page.'
        );
        authErr.code = 'AUTH_ERROR';
        authErr.connectionId = connectionId;
        throw authErr;
      }
      throw error;
    }
  );

  return instance;
}

// ---------------------------------------------------------------------------
// verifyAndRefreshCloudId
// ---------------------------------------------------------------------------

/**
 * Verify the stored cloudId for a connection against Atlassian accessible-resources.
 * Skips the network call if cloudIdVerifiedAt is within the last 24 hours.
 *
 * Side-effects:
 *   - Updates connection.cloudId if accessible-resources returns a different id for the same site.
 *   - Updates connection.cloudIdVerifiedAt on every successful verification.
 *   - Sets connection.status = 'CLOUD_ID_NOT_FOUND' and throws if no matching site is found.
 *
 * @param {string} connectionId
 * @returns {Promise<string>} The verified (and possibly updated) cloudId
 */
async function verifyAndRefreshCloudId(connectionId) {
  const connection = db.connections.get(connectionId);
  if (!connection) {
    throw new Error(`Connection not found: ${connectionId}`);
  }

  // Freshness gate: skip the API call if verified within the last 24 hours.
  if (connection.cloudIdVerifiedAt) {
    const age = Date.now() - new Date(connection.cloudIdVerifiedAt).getTime();
    if (age < CLOUD_ID_FRESHNESS_MS) {
      return connection.cloudId;
    }
  }

  // Re-resolve by calling accessible-resources with a valid access token.
  const accessToken = await getValidAccessToken(connectionId);

  let sites;
  try {
    const response = await axios.get(ATLASSIAN_RESOURCES_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    sites = response.data;
  } catch (err) {
    throw new Error(`Failed to fetch accessible-resources for cloudId verification: ${err.message}`);
  }

  // Match by siteUrl (normalised) or by existing cloudId.
  const storedUrl = (connection.siteUrl || '').replace(/\/$/, '').toLowerCase();
  const matchingSite = (sites || []).find((s) => {
    const resourceUrl = (s.url || '').replace(/\/$/, '').toLowerCase();
    return resourceUrl === storedUrl || s.id === connection.cloudId;
  });

  const now = new Date().toISOString();

  if (!matchingSite) {
    connection.status = 'CLOUD_ID_NOT_FOUND';
    connection.updatedAt = now;
    db.connections.set(connectionId, connection);
    db.saveDb();

    const cloudIdErr = new Error(
      `Atlassian site not found in accessible-resources for connection ${connectionId}. ` +
      'The site may have been deleted or access may have been revoked. Please reconnect the integration.'
    );
    cloudIdErr.code = 'CLOUD_ID_NOT_FOUND';
    cloudIdErr.connectionId = connectionId;
    throw cloudIdErr;
  }

  // Persist refreshed cloudId (handles site-migration case) and update verified timestamp.
  connection.cloudId = matchingSite.id;
  connection.cloudIdVerifiedAt = now;
  connection.updatedAt = now;
  db.connections.set(connectionId, connection);
  db.saveDb();

  return matchingSite.id;
}

module.exports = { refreshConnectionToken, getValidAccessToken, createJiraAxiosInstance, verifyAndRefreshCloudId };
