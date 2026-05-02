'use strict';

/**
 * Integration lifecycle routes:
 *   GET    /integrations/:id/token-health   - Check refresh token expiry status
 *   DELETE /integrations/:id               - Soft or Hard delete integration
 *   POST   /integrations/:id/restore       - Restore soft-deleted integration
 *   PATCH  /integrations/:id/project-scope - Update project scope configuration
 *   POST   /integrations/:id/reauthenticate - Re-run OAuth consent (refresh scopes/tokens in place)
 */

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { generateCodeVerifier, generateCodeChallenge } = require('../services/pkce');
const { getScopeString } = require('../services/scopeValidation');

const ATLASSIAN_AUTH_URL = 'https://auth.atlassian.com/authorize';
const DEFAULT_CLIENT_ID = process.env.ATLASSIAN_CLIENT_ID;
const DEFAULT_REDIRECT_URI = process.env.ATLASSIAN_REDIRECT_URI;
const STATE_TTL_SECONDS = parseInt(process.env.OAUTH_STATE_TTL_SECONDS || '600', 10);

const router = express.Router();

const REFRESH_TOKEN_EXPIRY_DAYS = 90;
const PROACTIVE_ALERT_THRESHOLD_DAYS = 80;
const DEFAULT_RETENTION_DAYS = parseInt(
  process.env.INTEGRATION_SOFT_DELETE_RETENTION_DAYS || '30',
  10
);

function errorResponse(res, status, code, message) {
  return res.status(status).json({ error: code, message });
}

function isHardDeleteAllowed() {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.ALLOW_HARD_DELETE === 'true'
  );
}

function daysBetween(date1, date2) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return (date2 - date1) / msPerDay;
}

// ---------------------------------------------------------------------------
// GET /integrations — list all non-hard-deleted connections
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const { status } = req.query;
  const connections = [];

  for (const conn of db.connections.values()) {
    if (conn.status === 'hard_deleted') continue;
    if (status && status !== 'all' && conn.status !== status) continue;

    connections.push({
      connectionId: conn.id,
      siteName: conn.siteName || conn.siteUrl || conn.cloudId,
      siteUrl: conn.siteUrl,
      status: conn.status,
      boardScopeDegraded: conn.boardScopeDegraded || false,
      connectedAt: conn.connectedAt,
      lastSyncedAt: conn.lastSyncedAt || null,
      connectionPath: conn.connectionPath,
      createdAt: conn.createdAt,
    });
  }

  return res.status(200).json({ connections, total: connections.length });
});

// ---------------------------------------------------------------------------
// GET /integrations/:id
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const connection = db.connections.get(req.params.id);
  if (!connection) {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No connection found with this ID');
  }

  return res.status(200).json({
    connectionId: connection.id,
    userId: connection.userId,
    cloudId: connection.cloudId,
    siteName: connection.siteName,
    siteUrl: connection.siteUrl,
    connectionPath: connection.connectionPath,
    status: connection.status,
    boardScopeDegraded: connection.boardScopeDegraded,
    grantedScopes: connection.grantedScopes,
    missingRequiredScopes: connection.missingRequiredScopes,
    projectScopeMode: connection.projectScopeMode,
    selectedProjectIds: connection.selectedProjectIds,
    includeArchivedProjects: connection.includeArchivedProjects,
    connectedAt: connection.connectedAt,
    lastSyncedAt: connection.lastSyncedAt,
    softDeletedAt: connection.softDeletedAt,
    softDeleteRetentionDays: connection.softDeleteRetentionDays,
    hardDeleteAllowed: isHardDeleteAllowed() && Boolean(connection.sandbox),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  });
});

// ---------------------------------------------------------------------------
// GET /integrations/:id/token-health
// ---------------------------------------------------------------------------
router.get('/:id/token-health', (req, res) => {
  const connection = db.connections.get(req.params.id);
  if (!connection) {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No connection found with this ID');
  }

  if (connection.status === 'soft_deleted' || connection.status === 'hard_deleted') {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'Connection has been deleted');
  }

  const now = new Date();
  const lastUsed = new Date(connection.refreshTokenLastUsedAt);
  const daysInactive = daysBetween(lastUsed, now);
  const daysRemaining = Math.max(0, REFRESH_TOKEN_EXPIRY_DAYS - daysInactive);

  let status;
  if (daysInactive >= REFRESH_TOKEN_EXPIRY_DAYS) {
    status = 'expired';
  } else if (daysInactive >= PROACTIVE_ALERT_THRESHOLD_DAYS) {
    status = 'expiring_soon';
  } else {
    status = 'healthy';
  }

  return res.status(200).json({
    connectionId: connection.id,
    status,
    daysRemaining: Math.floor(daysRemaining),
    daysInactive: Math.floor(daysInactive),
    refreshTokenLastUsedAt: connection.refreshTokenLastUsedAt,
    proactiveAlertThresholdDays: PROACTIVE_ALERT_THRESHOLD_DAYS,
    expiryDays: REFRESH_TOKEN_EXPIRY_DAYS,
  });
});

// ---------------------------------------------------------------------------
// DELETE /integrations/:id
// ---------------------------------------------------------------------------
router.delete('/:id', (req, res) => {
  const { deleteMode = 'soft', retentionDays } = req.body || {};
  const connectionId = req.params.id;

  const connection = db.connections.get(connectionId);
  if (!connection) {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No connection found with this ID');
  }

  if (connection.status === 'soft_deleted' || connection.status === 'hard_deleted') {
    return errorResponse(res, 409, 'ALREADY_DELETED', 'Connection has already been deleted');
  }

  if (deleteMode === 'hard') {
    if (!isHardDeleteAllowed()) {
      return errorResponse(res, 403, 'HARD_DELETE_NOT_ALLOWED', 'Hard delete is only allowed in sandbox environments');
    }
    if (!connection.sandbox) {
      return errorResponse(res, 403, 'HARD_DELETE_NOT_ALLOWED', 'Hard delete requires connection.sandbox to be true');
    }

    const now = new Date().toISOString();
    connection.status = 'hard_deleted';
    connection.hardDeletedAt = now;
    connection.updatedAt = now;
    db.connections.set(connectionId, connection);

    // Emit HARD_DELETED lifecycle event
    db.lifecycleEvents.set(uuidv4(), {
      id: uuidv4(),
      connectionId,
      eventType: 'HARD_DELETED',
      actorUserId: connection.userId,
      metadata: { immediate: true },
      occurredAt: now,
    });

    return res.status(200).json({
      connectionId,
      deleteMode: 'hard',
      status: 'hard_deleted',
      softDeletedAt: null,
      scheduledPurgeAt: null,
      retentionDays: null,
      restorable: false,
    });
  }

  // Soft delete
  const effectiveRetentionDays =
    retentionDays !== undefined
      ? Math.min(90, Math.max(1, parseInt(retentionDays, 10)))
      : DEFAULT_RETENTION_DAYS;

  const now = new Date();
  const nowIso = now.toISOString();
  const scheduledPurgeAt = new Date(
    now.getTime() + effectiveRetentionDays * 24 * 60 * 60 * 1000
  ).toISOString();

  connection.status = 'soft_deleted';
  connection.softDeletedAt = nowIso;
  connection.softDeleteRetentionDays = effectiveRetentionDays;
  connection.updatedAt = nowIso;
  db.connections.set(connectionId, connection);

  // Emit SOFT_DELETED lifecycle event
  db.lifecycleEvents.set(uuidv4(), {
    id: uuidv4(),
    connectionId,
    eventType: 'SOFT_DELETED',
    actorUserId: connection.userId,
    metadata: { retentionDays: effectiveRetentionDays, scheduledPurgeAt },
    occurredAt: nowIso,
  });

  return res.status(200).json({
    connectionId,
    deleteMode: 'soft',
    status: 'soft_deleted',
    softDeletedAt: nowIso,
    scheduledPurgeAt,
    retentionDays: effectiveRetentionDays,
    restorable: true,
  });
});

// ---------------------------------------------------------------------------
// POST /integrations/:id/restore
// ---------------------------------------------------------------------------
router.post('/:id/restore', (req, res) => {
  const connectionId = req.params.id;
  const connection = db.connections.get(connectionId);

  if (!connection) {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No connection found with this ID');
  }

  if (connection.status !== 'soft_deleted') {
    return errorResponse(res, 409, 'NOT_SOFT_DELETED', 'Connection is not in a soft-deleted state');
  }

  const now = new Date();
  const softDeletedAt = new Date(connection.softDeletedAt);
  const retentionWindowExpires = new Date(
    softDeletedAt.getTime() + connection.softDeleteRetentionDays * 24 * 60 * 60 * 1000
  );

  if (now > retentionWindowExpires) {
    return errorResponse(res, 410, 'RETENTION_WINDOW_EXPIRED', 'The retention window has expired; data has been purged');
  }

  const nowIso = now.toISOString();
  connection.status = connection.boardScopeDegraded ? 'degraded' : 'active';
  connection.softDeletedAt = null;
  connection.updatedAt = nowIso;
  db.connections.set(connectionId, connection);

  // Emit RESTORED lifecycle event
  db.lifecycleEvents.set(uuidv4(), {
    id: uuidv4(),
    connectionId,
    eventType: 'RESTORED',
    actorUserId: connection.userId,
    metadata: {},
    occurredAt: nowIso,
  });

  return res.status(200).json({
    connectionId,
    status: connection.status,
    restoredAt: nowIso,
  });
});

// ---------------------------------------------------------------------------
// PATCH /integrations/:id/project-scope
// ---------------------------------------------------------------------------
router.patch('/:id/project-scope', (req, res) => {
  const connectionId = req.params.id;
  const { projectScopeMode, selectedProjectIds, includeArchivedProjects } = req.body || {};

  const connection = db.connections.get(connectionId);
  if (!connection) {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No connection found with this ID');
  }

  if (connection.status === 'soft_deleted' || connection.status === 'hard_deleted') {
    return errorResponse(res, 409, 'CONNECTION_DELETED', 'Cannot update a deleted connection');
  }

  if (projectScopeMode !== undefined) {
    if (!['all', 'selected'].includes(projectScopeMode)) {
      return errorResponse(res, 400, 'INVALID_PROJECT_SCOPE_MODE', "projectScopeMode must be 'all' or 'selected'");
    }
    connection.projectScopeMode = projectScopeMode;
  }

  if (selectedProjectIds !== undefined) {
    if (!Array.isArray(selectedProjectIds)) {
      return errorResponse(res, 400, 'INVALID_SELECTED_PROJECT_IDS', 'selectedProjectIds must be an array');
    }
    connection.selectedProjectIds = selectedProjectIds;
  }

  if (includeArchivedProjects !== undefined) {
    connection.includeArchivedProjects = Boolean(includeArchivedProjects);
  }

  connection.updatedAt = new Date().toISOString();
  db.connections.set(connectionId, connection);

  return res.status(200).json({
    connectionId,
    projectScopeMode: connection.projectScopeMode,
    selectedProjectIds: connection.selectedProjectIds,
    includeArchivedProjects: connection.includeArchivedProjects,
    updatedAt: connection.updatedAt,
  });
});

// ---------------------------------------------------------------------------
// POST /integrations/:id/reauthenticate
// Initiates an in-place OAuth re-consent for the existing integration.
// Returns the Atlassian authorization URL; the callback handler updates tokens
// on the SAME connection record (UUID preserved).
// ---------------------------------------------------------------------------
router.post('/:id/reauthenticate', (req, res) => {
  const connectionId = req.params.id;
  const connection = db.connections.get(connectionId);

  if (!connection) {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'No connection found with this ID');
  }

  if (connection.status === 'hard_deleted') {
    return errorResponse(res, 404, 'CONNECTION_NOT_FOUND', 'Connection has been deleted');
  }

  // Use the clientId from the connection (Manual path) or fall back to global env (Express path)
  const clientId = connection.clientId || DEFAULT_CLIENT_ID;
  const redirectUri = DEFAULT_REDIRECT_URI;

  if (!clientId) {
    return errorResponse(res, 500, 'MISSING_CLIENT_ID', 'OAuth client ID is not configured');
  }
  if (!redirectUri) {
    return errorResponse(res, 500, 'MISSING_REDIRECT_URI', 'OAuth redirect URI is not configured');
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

  // Store state with a marker so the callback knows to UPDATE the existing connection
  db.pendingStates.set(state, {
    state,
    codeVerifier,
    userId: connection.userId,
    redirectUri,
    path: connection.connectionPath || 'express',
    reauthConnectionId: connectionId,  // key: signals in-place update
    expiresAt,
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: getScopeString(),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
    audience: 'api.atlassian.com',
  });
  const authorizationUrl = `${ATLASSIAN_AUTH_URL}?${params.toString()}`;

  return res.status(200).json({ authorizationUrl, state, expiresAt, connectionId });
});

module.exports = router;
