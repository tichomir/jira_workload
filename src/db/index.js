'use strict';

/**
 * In-memory data store.
 * In production, replace with a real database (PostgreSQL, etc.).
 * All collections are plain Maps keyed by record ID.
 */

// OAuthConnection records (keyed by id)
const connections = new Map();

// Pending OAuth state records (keyed by state UUID)
// Shape: { state, codeVerifier, userId, expiresAt, clientId?, clientSecret?, redirectUri?, path }
const pendingStates = new Map();

// CloudSite records (keyed by id)
const cloudSites = new Map();

// IntegrationLifecycleEvent records (keyed by id)
const lifecycleEvents = new Map();

// ScopeValidationResult records (keyed by id)
const scopeValidations = new Map();

/**
 * Clean up expired state records (called lazily).
 */
function pruneExpiredStates() {
  const now = new Date();
  for (const [key, value] of pendingStates.entries()) {
    if (new Date(value.expiresAt) < now) {
      pendingStates.delete(key);
    }
  }
}

module.exports = {
  connections,
  pendingStates,
  cloudSites,
  lifecycleEvents,
  scopeValidations,
  pruneExpiredStates,
};
