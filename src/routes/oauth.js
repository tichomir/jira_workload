'use strict';

/**
 * OAuth routes:
 *   POST  /oauth/express/redirect   - Generate Express OAuth authorization URL
 *   GET   /oauth/express/callback   - OAuth callback (code exchange, cloudId resolution)
 *   POST  /oauth/manual/connect     - Initiate Manual OAuth path
 *   GET   /oauth/sites              - Retrieve accessible sites
 *   POST  /oauth/sites/select       - Select cloud site for multi-site connection
 *   POST  /oauth/scopes/validate    - On-demand scope re-validation
 */

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const { generateCodeVerifier, generateCodeChallenge } = require('../services/pkce');
const { encrypt, decrypt } = require('../services/crypto');
const { getScopeString, validateScopes } = require('../services/scopeValidation');
const db = require('../db');

const router = express.Router();

const ATLASSIAN_AUTH_URL = 'https://auth.atlassian.com/authorize';
const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ATLASSIAN_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

const STATE_TTL_SECONDS = parseInt(process.env.OAUTH_STATE_TTL_SECONDS || '600', 10);
const DEFAULT_CLIENT_ID = process.env.ATLASSIAN_CLIENT_ID;
const DEFAULT_CLIENT_SECRET = process.env.ATLASSIAN_CLIENT_SECRET;
const DEFAULT_REDIRECT_URI = process.env.ATLASSIAN_REDIRECT_URI;
const FRONTEND_BASE = process.env.FRONTEND_BASE_URL || 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResponse(res, status, code, message, details) {
  const body = { error: code, message };
  if (details) body.details = details;
  return res.status(status).json(body);
}

function isValidHttpsUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidAtlassianSiteUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname.endsWith('.atlassian.net') || parsed.hostname.length > 0)
    );
  } catch {
    return false;
  }
}

/**
 * Build an Atlassian authorization URL.
 */
function buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge, scopes }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
    audience: 'api.atlassian.com',
  });
  return `${ATLASSIAN_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens via Atlassian token endpoint.
 */
async function exchangeCodeForTokens({ clientId, clientSecret, code, redirectUri, codeVerifier }) {
  const response = await axios.post(ATLASSIAN_TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  return response.data;
}

/**
 * Fetch accessible resources (sites) from Atlassian.
 */
async function fetchAccessibleResources(accessToken) {
  const response = await axios.get(ATLASSIAN_RESOURCES_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return response.data; // Array of { id, name, url, scopes, avatarUrl }
}

/**
 * Finalize a connection: upsert OAuthConnection record, store CloudSite, emit lifecycle event.
 */
function finalizeConnection({
  userId,
  cloudId,
  siteName,
  siteUrl,
  accessToken,
  refreshToken,
  accessTokenExpiresIn,
  grantedScopes,
  validationResult,
  clientId,
  clientSecret,
  connectionPath,
}) {
  const now = new Date();
  const connectionId = uuidv4();

  const boardScopeDegraded = validationResult.missingOptionalScopes.includes(
    'read:board-scope:jira-software'
  );

  const connection = {
    id: connectionId,
    userId,
    cloudId,
    siteName,
    siteUrl,
    accessToken: encrypt(accessToken),
    refreshToken: encrypt(refreshToken),
    accessTokenExpiresAt: new Date(now.getTime() + accessTokenExpiresIn * 1000).toISOString(),
    refreshTokenLastUsedAt: now.toISOString(),
    refreshTokenExpiresAt: null,
    clientId: clientId || null,
    clientSecret: clientSecret ? encrypt(clientSecret) : null,
    connectionPath,
    grantedScopes,
    missingRequiredScopes: validationResult.missingRequiredScopes,
    boardScopeDegraded,
    status: boardScopeDegraded ? 'degraded' : 'active',
    connectedAt: now.toISOString(),
    lastSyncedAt: null,
    softDeletedAt: null,
    hardDeletedAt: null,
    softDeleteRetentionDays: parseInt(
      process.env.INTEGRATION_SOFT_DELETE_RETENTION_DAYS || '30',
      10
    ),
    projectScopeMode: 'all',
    selectedProjectIds: [],
    includeArchivedProjects: false,
    refreshExpiryAlertSentAt: null,
    refreshExpiredBannerDismissedAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  db.connections.set(connectionId, connection);

  // Emit CONNECTED lifecycle event
  const event = {
    id: uuidv4(),
    connectionId,
    eventType: 'CONNECTED',
    actorUserId: userId,
    metadata: { connectionPath, cloudId, boardScopeDegraded },
    occurredAt: now.toISOString(),
  };
  db.lifecycleEvents.set(event.id, event);

  return connection;
}

// ---------------------------------------------------------------------------
// POST /oauth/express/redirect
// ---------------------------------------------------------------------------
router.post('/express/redirect', (req, res) => {
  const { userId, redirectUri } = req.body || {};

  if (!userId) {
    return errorResponse(res, 400, 'MISSING_USER_ID', 'userId is required');
  }

  const effectiveRedirectUri = redirectUri || DEFAULT_REDIRECT_URI;
  if (!effectiveRedirectUri) {
    return errorResponse(res, 400, 'INVALID_REDIRECT_URI', 'Redirect URI is required');
  }
  if (!isValidHttpsUrl(effectiveRedirectUri)) {
    return errorResponse(res, 400, 'INVALID_REDIRECT_URI', 'Redirect URI must be a valid HTTPS URL');
  }

  let codeVerifier, codeChallenge;
  try {
    codeVerifier = generateCodeVerifier();
    codeChallenge = generateCodeChallenge(codeVerifier);
  } catch (err) {
    return errorResponse(res, 500, 'PKCE_GENERATION_FAILED', 'Failed to generate PKCE parameters');
  }

  const state = uuidv4();
  const expiresAt = new Date(Date.now() + STATE_TTL_SECONDS * 1000).toISOString();

  db.pendingStates.set(state, {
    state,
    codeVerifier,
    userId,
    redirectUri: effectiveRedirectUri,
    path: 'express',
    expiresAt,
  });

  const authorizationUrl = buildAuthorizationUrl({
    clientId: DEFAULT_CLIENT_ID,
    redirectUri: effectiveRedirectUri,
    state,
    codeChallenge,
    scopes: getScopeString(),
  });

  return res.status(200).json({ authorizationUrl, state, expiresAt });
});

// ---------------------------------------------------------------------------
// GET /oauth/express/callback
// ---------------------------------------------------------------------------
router.get('/express/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    const redirectUrl = `${FRONTEND_BASE}/integrations/jira/callback?status=error&code=ACCESS_DENIED&description=${encodeURIComponent(error_description || error)}`;
    return res.redirect(redirectUrl);
  }

  if (!code || !state) {
    const redirectUrl = `${FRONTEND_BASE}/integrations/jira/callback?status=error&code=STATE_INVALID&description=Missing+code+or+state`;
    return res.redirect(redirectUrl);
  }

  db.pruneExpiredStates();
  const stateRecord = db.pendingStates.get(state);

  if (!stateRecord) {
    const redirectUrl = `${FRONTEND_BASE}/integrations/jira/callback?status=error&code=STATE_INVALID&description=State+not+found`;
    return res.redirect(redirectUrl);
  }

  if (new Date(stateRecord.expiresAt) < new Date()) {
    db.pendingStates.delete(state);
    const redirectUrl = `${FRONTEND_BASE}/integrations/jira/callback?status=error&code=STATE_EXPIRED&description=State+TTL+exceeded`;
    return res.redirect(redirectUrl);
  }

  // One-time use: delete the state record
  db.pendingStates.delete(state);

  let tokenData;
  try {
    tokenData = await exchangeCodeForTokens({
      clientId: DEFAULT_CLIENT_ID,
      clientSecret: DEFAULT_CLIENT_SECRET,
      code,
      redirectUri: stateRecord.redirectUri,
      codeVerifier: stateRecord.codeVerifier,
    });
  } catch (err) {
    const redirectUrl = `${FRONTEND_BASE}/integrations/jira/callback?status=error&code=TOKEN_EXCHANGE_FAILED&description=${encodeURIComponent(err.message)}`;
    return res.redirect(redirectUrl);
  }

  const { access_token, refresh_token, expires_in, scope } = tokenData;
  const grantedScopes = scope ? scope.split(' ') : [];

  let sites;
  try {
    sites = await fetchAccessibleResources(access_token);
  } catch (err) {
    const redirectUrl = `${FRONTEND_BASE}/integrations/jira/callback?status=error&code=ACCESSIBLE_RESOURCES_FAILED&description=${encodeURIComponent(err.message)}`;
    return res.redirect(redirectUrl);
  }

  if (!sites || sites.length === 0) {
    const redirectUrl = `${FRONTEND_BASE}/integrations/jira/callback?status=error&code=NO_SITES_FOUND&description=No+accessible+Atlassian+sites+found`;
    return res.redirect(redirectUrl);
  }

  const validationResult = validateScopes(grantedScopes, null, null);
  if (!validationResult.connectionAllowed) {
    const redirectUrl = `${FRONTEND_BASE}/integrations/jira/callback?status=error&code=SCOPE_VALIDATION_FAILED&description=Required+scopes+missing`;
    return res.redirect(redirectUrl);
  }

  if (sites.length === 1) {
    const site = sites[0];
    const connection = finalizeConnection({
      userId: stateRecord.userId,
      cloudId: site.id,
      siteName: site.name,
      siteUrl: site.url,
      accessToken: access_token,
      refreshToken: refresh_token,
      accessTokenExpiresIn: expires_in,
      grantedScopes,
      validationResult,
      connectionPath: 'express',
    });

    // Store CloudSite
    const cloudSite = {
      id: uuidv4(),
      cloudId: site.id,
      name: site.name,
      url: site.url,
      avatarUrl: site.avatarUrl || null,
      availableScopes: site.scopes || [],
      connectionId: connection.id,
      resolvedAt: new Date().toISOString(),
      cacheExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.cloudSites.set(cloudSite.id, cloudSite);

    const redirectUrl = `${FRONTEND_BASE}/integrations/jira/callback?connectionId=${connection.id}&status=success`;
    return res.redirect(redirectUrl);
  }

  // Multiple sites: store pending connection with all data for site selection
  const pendingConnectionId = uuidv4();
  db.pendingStates.set(`pending_conn_${pendingConnectionId}`, {
    type: 'pending_connection',
    connectionId: pendingConnectionId,
    userId: stateRecord.userId,
    accessToken: access_token,
    refreshToken: refresh_token,
    accessTokenExpiresIn: expires_in,
    grantedScopes,
    validationResult,
    sites,
    connectionPath: 'express',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min to complete site selection
  });

  const redirectUrl = `${FRONTEND_BASE}/integrations/jira/callback?connectionId=${pendingConnectionId}&status=success&requiresSiteSelection=true`;
  return res.redirect(redirectUrl);
});

// ---------------------------------------------------------------------------
// POST /oauth/manual/connect
// ---------------------------------------------------------------------------
router.post('/manual/connect', (req, res) => {
  const { clientId, clientSecret, siteUrl, redirectUri } = req.body || {};

  if (!clientId || typeof clientId !== 'string' || !clientId.trim()) {
    return errorResponse(res, 400, 'INVALID_CLIENT_ID', 'clientId is required and must be a non-empty string');
  }
  if (!clientSecret || typeof clientSecret !== 'string' || clientSecret.length < 16) {
    return errorResponse(res, 400, 'INVALID_CLIENT_SECRET', 'clientSecret must be at least 16 characters');
  }
  if (!siteUrl || !isValidAtlassianSiteUrl(siteUrl)) {
    return errorResponse(res, 400, 'INVALID_SITE_URL', 'siteUrl must be a valid HTTPS Atlassian URL');
  }
  if (!redirectUri || !isValidHttpsUrl(redirectUri)) {
    return errorResponse(res, 400, 'INVALID_REDIRECT_URI', 'redirectUri must be a valid HTTPS URL');
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = uuidv4();
  const expiresAt = new Date(Date.now() + STATE_TTL_SECONDS * 1000).toISOString();

  db.pendingStates.set(state, {
    state,
    codeVerifier,
    clientId,
    clientSecret,  // stored temporarily; will be encrypted once used
    redirectUri,
    siteUrl,
    path: 'manual',
    expiresAt,
  });

  const authorizationUrl = buildAuthorizationUrl({
    clientId,
    redirectUri,
    state,
    codeChallenge,
    scopes: getScopeString(),
  });

  const scopeList = getScopeString().split(' ');

  return res.status(200).json({
    authorizationUrl,
    state,
    expiresAt,
    confirmationDetails: {
      clientIdMasked: clientId.length > 4
        ? '...' + clientId.slice(-4)
        : clientId,
      redirectUri,
      siteUrl,
      requestedScopes: scopeList,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /oauth/sites
// ---------------------------------------------------------------------------
router.get('/sites', (req, res) => {
  const { connectionId } = req.query;

  if (!connectionId) {
    return errorResponse(res, 400, 'MISSING_CONNECTION_ID', 'connectionId query parameter is required');
  }

  const pendingKey = `pending_conn_${connectionId}`;
  const pending = db.pendingStates.get(pendingKey);

  if (!pending || pending.type !== 'pending_connection') {
    // Check if it's a finalized connection and return its site
    const connection = db.connections.get(connectionId);
    if (!connection) {
      return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No pending connection found with this ID');
    }

    // Return the site for the established connection
    const site = [...db.cloudSites.values()].find((s) => s.connectionId === connectionId);
    if (!site) {
      return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No site data found for this connection');
    }

    return res.status(200).json({
      sites: [{ cloudId: site.cloudId, name: site.name, url: site.url, avatarUrl: site.avatarUrl }],
      autoSelected: true,
      selectedCloudId: site.cloudId,
    });
  }

  const { sites } = pending;
  const autoSelected = sites.length === 1;

  return res.status(200).json({
    sites: sites.map((s) => ({
      cloudId: s.id,
      name: s.name,
      url: s.url,
      avatarUrl: s.avatarUrl || null,
    })),
    autoSelected,
    selectedCloudId: autoSelected ? sites[0].id : null,
  });
});

// ---------------------------------------------------------------------------
// POST /oauth/sites/select
// ---------------------------------------------------------------------------
router.post('/sites/select', async (req, res) => {
  const { connectionId, cloudId } = req.body || {};

  if (!connectionId || !cloudId) {
    return errorResponse(res, 400, 'MISSING_PARAMS', 'connectionId and cloudId are required');
  }

  const pendingKey = `pending_conn_${connectionId}`;
  const pending = db.pendingStates.get(pendingKey);

  if (!pending || pending.type !== 'pending_connection') {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No pending connection found with this ID');
  }

  if (new Date(pending.expiresAt) < new Date()) {
    db.pendingStates.delete(pendingKey);
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'Pending connection has expired');
  }

  const selectedSite = pending.sites.find((s) => s.id === cloudId);
  if (!selectedSite) {
    return errorResponse(res, 400, 'INVALID_CLOUD_ID', 'The provided cloudId is not in the accessible sites list');
  }

  // Check for existing active connection for this user+cloudId
  for (const conn of db.connections.values()) {
    if (
      conn.userId === pending.userId &&
      conn.cloudId === cloudId &&
      conn.status !== 'soft_deleted' &&
      conn.status !== 'hard_deleted'
    ) {
      return errorResponse(res, 409, 'SITE_ALREADY_CONNECTED', 'An active connection for this site already exists');
    }
  }

  db.pendingStates.delete(pendingKey);

  const connection = finalizeConnection({
    userId: pending.userId,
    cloudId,
    siteName: selectedSite.name,
    siteUrl: selectedSite.url,
    accessToken: pending.accessToken,
    refreshToken: pending.refreshToken,
    accessTokenExpiresIn: pending.accessTokenExpiresIn,
    grantedScopes: pending.grantedScopes,
    validationResult: pending.validationResult,
    connectionPath: pending.connectionPath,
  });

  // Store CloudSite
  const cloudSite = {
    id: uuidv4(),
    cloudId: selectedSite.id,
    name: selectedSite.name,
    url: selectedSite.url,
    avatarUrl: selectedSite.avatarUrl || null,
    availableScopes: selectedSite.scopes || [],
    connectionId: connection.id,
    resolvedAt: new Date().toISOString(),
    cacheExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.cloudSites.set(cloudSite.id, cloudSite);

  // Emit SITE_SELECTED lifecycle event
  db.lifecycleEvents.set(uuidv4(), {
    id: uuidv4(),
    connectionId: connection.id,
    eventType: 'SITE_SELECTED',
    actorUserId: pending.userId,
    metadata: { cloudId, siteName: selectedSite.name },
    occurredAt: new Date().toISOString(),
  });

  return res.status(200).json({
    connectionId: connection.id,
    cloudId: connection.cloudId,
    siteName: connection.siteName,
    status: connection.status,
    grantedScopes: connection.grantedScopes,
    missingScopes: connection.missingRequiredScopes,
    degradedFeatures: pending.validationResult.degradedFeatures,
    boardScopeDegraded: connection.boardScopeDegraded,
  });
});

// ---------------------------------------------------------------------------
// POST /oauth/scopes/validate
// ---------------------------------------------------------------------------
router.post('/scopes/validate', (req, res) => {
  const { connectionId } = req.body || {};

  if (!connectionId) {
    return errorResponse(res, 400, 'MISSING_CONNECTION_ID', 'connectionId is required');
  }

  const connection = db.connections.get(connectionId);
  if (!connection) {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No connection found with this ID');
  }

  const validationResult = validateScopes(
    connection.grantedScopes,
    connection.id,
    connection.cloudId
  );

  db.scopeValidations.set(validationResult.id, validationResult);

  return res.status(200).json({
    validationId: validationResult.id,
    connectionId: validationResult.connectionId,
    overallStatus: validationResult.overallStatus,
    connectionAllowed: validationResult.connectionAllowed,
    entries: validationResult.entries,
    grantedScopes: validationResult.grantedScopes,
    missingRequiredScopes: validationResult.missingRequiredScopes,
    missingOptionalScopes: validationResult.missingOptionalScopes,
    degradedFeatures: validationResult.degradedFeatures,
    validatedAt: validationResult.validatedAt,
  });
});

module.exports = router;
