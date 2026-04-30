'use strict';

/**
 * Sprint 3 — User Preferences Routes
 *
 * Endpoints:
 *   GET /api/v1/preferences  — Get all preferences for the current user
 *   PUT /api/v1/preferences  — Set a preference value
 *
 * Architecture reference: §5.2 (Preference API)
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

function errorResponse(res, status, code, message) {
  return res.status(status).json({ error: code, message });
}

// Preference registry: key → allowed value type
const PREFERENCE_REGISTRY = {
  'platform.objectExplorer.showUnchangedObjects': 'boolean',
};

/**
 * Resolve the effective userId from the request.
 * In production, this comes from the session/JWT. Here we use a header or default.
 */
function resolveUserId(req) {
  return req.headers['x-user-id'] || 'default-user';
}

/**
 * Resolve the effective integrationId from the request.
 */
function resolveIntegrationId(req) {
  return req.headers['x-integration-id'] || 'default-integration';
}

/**
 * Build the Map key for a user preference.
 */
function prefKey(userId, integrationId, key) {
  return `${userId}:${integrationId}:${key}`;
}

// ---------------------------------------------------------------------------
// GET /api/v1/preferences
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const userId = resolveUserId(req);
  const integrationId = resolveIntegrationId(req);

  const preferences = {};

  // Load all known preference keys for this user+integration
  for (const key of Object.keys(PREFERENCE_REGISTRY)) {
    const stored = db.userPreferences.get(prefKey(userId, integrationId, key));
    if (stored !== undefined) {
      preferences[key] = stored.value;
    }
  }

  return res.status(200).json({ preferences });
});

// ---------------------------------------------------------------------------
// PUT /api/v1/preferences
// ---------------------------------------------------------------------------
router.put('/', (req, res) => {
  const { key, value } = req.body || {};
  const userId = resolveUserId(req);
  const integrationId = resolveIntegrationId(req);

  // Validate key
  if (!key || !(key in PREFERENCE_REGISTRY)) {
    return errorResponse(res, 400, 'INVALID_PREFERENCE_KEY',
      `key must be one of: ${Object.keys(PREFERENCE_REGISTRY).join(', ')}`);
  }

  // Validate value type
  const expectedType = PREFERENCE_REGISTRY[key];
  if (typeof value !== expectedType) {
    return errorResponse(res, 400, 'INVALID_PREFERENCE_VALUE',
      `value for key "${key}" must be of type ${expectedType}`);
  }

  const updatedAt = new Date().toISOString();
  const pk = prefKey(userId, integrationId, key);

  const existing = db.userPreferences.get(pk);
  db.userPreferences.set(pk, {
    id: existing ? existing.id : uuidv4(),
    userId,
    integrationId,
    key,
    value,
    updatedAt,
  });

  return res.status(200).json({ key, value, updatedAt });
});

module.exports = router;
