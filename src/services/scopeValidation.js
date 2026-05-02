'use strict';

/**
 * OAuth scope validation.
 *
 * Source of truth for the scope list: src/config/scopes.js
 * This module wraps the manifest and exposes validation helpers.
 */

const { v4: uuidv4 } = require('uuid');
const { SCOPE_MANIFEST, SCOPE_NAMES, SCOPE_STRING, BOARD_SCOPES } = require('../config/scopes');

// Re-export the matrix under its legacy name so existing callers don't break.
const SCOPE_MATRIX = SCOPE_MANIFEST;

/**
 * Returns the full scope string for the authorization URL.
 */
function getScopeString() {
  return SCOPE_STRING;
}

/**
 * Validate granted scopes against the 21-scope manifest.
 * @param {string[]} grantedScopes - Array of scope strings from the token response
 * @param {string} connectionId - OAuthConnection ID
 * @param {string} cloudId - Atlassian cloudId
 * @returns {object} ScopeValidationResult
 */
function validateScopes(grantedScopes, connectionId, cloudId) {
  const grantedSet = new Set(grantedScopes);

  const entries = SCOPE_MANIFEST.map((def) => {
    const granted = grantedSet.has(def.scope);
    return {
      scope: def.scope,
      required: def.required,
      granted,
      severity: granted ? 'OK' : def.severity,
      remediationMessage: granted ? null : def.remediationMessage,
      affectedFeatures: granted ? [] : def.affectedFeatures,
    };
  });

  const missingRequired = entries.filter((e) => e.required && !e.granted).map((e) => e.scope);
  const missingOptional = entries.filter((e) => !e.required && !e.granted).map((e) => e.scope);

  // DEGRADED if any board-scope optional scope is missing (but no required scope missing).
  const anyBoardScopeMissing = missingOptional.some((s) => BOARD_SCOPES.has(s));

  const degradedFeatures = entries
    .filter((e) => !e.required && !e.granted)
    .flatMap((e) => e.affectedFeatures);

  let overallStatus;
  let connectionAllowed;

  if (missingRequired.length > 0) {
    overallStatus = 'FAIL';
    connectionAllowed = false;
  } else if (anyBoardScopeMissing) {
    overallStatus = 'DEGRADED';
    connectionAllowed = true;
  } else {
    overallStatus = 'PASS';
    connectionAllowed = true;
  }

  return {
    id: uuidv4(),
    connectionId: connectionId || null,
    cloudId: cloudId || null,
    overallStatus,
    connectionAllowed,
    entries,
    grantedScopes: [...grantedSet],
    missingRequiredScopes: missingRequired,
    missingOptionalScopes: missingOptional,
    degradedFeatures,
    validatedAt: new Date().toISOString(),
  };
}

module.exports = { SCOPE_MATRIX, SCOPE_NAMES, getScopeString, validateScopes };
