'use strict';

/**
 * Sprint 10 QA Test Suite
 *
 * Validates the OAuth 3LO callback route alias fix:
 *   GET /oauth/callback  (used by Atlassian redirect URI https://localhost:4443/oauth/callback)
 *
 * Acceptance criteria:
 *  1. Happy path: /oauth/callback exchanges code, stores tokens, resolves cloudId,
 *     redirects to success — no 404 / NOT_FOUND error.
 *  2. Tampered/invalid state: rejected with STATE_INVALID redirect; no tokens stored.
 *  3. Expired / invalid code (token exchange failure): graceful error redirect,
 *     not an unhandled exception.
 *  4. cloudId resolved from accessible-resources and stored after token exchange.
 *  5. The exact path https://localhost:4443/oauth/callback is accepted as a valid
 *     redirect URI (HTTPS enforcement passes for Caddy local dev URL).
 */

// ---------------------------------------------------------------------------
// Environment setup
// ---------------------------------------------------------------------------
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = 'aabbccddeeff00112233445566778899aabbccddeeff001122334455667788990011'.slice(0, 64);
process.env.ATLASSIAN_CLIENT_ID        = 'test-client-id';
process.env.ATLASSIAN_CLIENT_SECRET    = 'test-client-secret-xyz';
process.env.ATLASSIAN_REDIRECT_URI     = 'https://localhost:4443/oauth/callback';
process.env.ALLOW_HARD_DELETE          = 'true';
process.env.NODE_ENV                   = 'test';
process.env.FRONTEND_BASE_URL          = 'https://localhost:4443';

jest.mock('axios');

const request = require('supertest');
const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = require('../src/app');
const db  = require('../src/db');
const { SCOPE_NAMES } = require('../src/services/scopeValidation');

const ALL_SCOPES = SCOPE_NAMES; // 20 scopes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seed a valid pending state record as if POST /oauth/express/redirect ran.
 * Uses the Caddy HTTPS redirect URI that Atlassian will redirect back to.
 */
function seedPendingState(stateId, overrides = {}) {
  db.pendingStates.set(stateId, {
    state: stateId,
    codeVerifier: 'test-code-verifier-sprint10',
    userId: 'user-sprint10',
    redirectUri: 'https://localhost:4443/oauth/callback',
    path: 'express',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ...overrides,
  });
}

/**
 * Mock a successful Atlassian token exchange + accessible-resources response.
 */
function mockSuccessfulTokenExchange(cloudId = 'cloud-sprint10', siteName = 'Sprint10 Site') {
  axios.post.mockResolvedValueOnce({
    data: {
      access_token: 'at-sprint10',
      refresh_token: 'rt-sprint10',
      expires_in: 3600,
      scope: ALL_SCOPES.join(' '),
    },
  });
  axios.get.mockResolvedValueOnce({
    data: [
      {
        id: cloudId,
        name: siteName,
        url: `https://${cloudId}.atlassian.net`,
        scopes: ALL_SCOPES,
        avatarUrl: null,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Reset state before each test
// ---------------------------------------------------------------------------
beforeEach(() => {
  db.connections.clear();
  db.pendingStates.clear();
  db.cloudSites.clear();
  db.lifecycleEvents.clear();
  db.scopeValidations.clear();
  jest.clearAllMocks();
});

// ============================================================
// TC-1: Happy path via /oauth/callback alias
// ============================================================
describe('TC-1: Happy path — GET /oauth/callback (Atlassian redirect URI alias)', () => {
  test('returns 302 redirect to success page, not a 404 NOT_FOUND JSON response', async () => {
    seedPendingState('happy-state-10');
    mockSuccessfulTokenExchange('cloud-happy', 'Happy Site');

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'auth-code-happy', state: 'happy-state-10' })
      .redirects(0);

    // Must be a redirect — not a 404 JSON blob
    expect(res.status).toBe(302);
    expect(res.headers.location).toBeDefined();
    // Must NOT be the 404 handler
    expect(res.body).not.toMatchObject({ error: 'NOT_FOUND' });
  });

  test('redirect location contains status=success', async () => {
    seedPendingState('happy-state-10b');
    mockSuccessfulTokenExchange('cloud-happy-b', 'Happy Site B');

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'auth-code-happy-b', state: 'happy-state-10b' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('status=success');
    expect(res.headers.location).not.toContain('status=error');
  });

  test('tokens are stored encrypted (not plaintext) after successful callback', async () => {
    seedPendingState('happy-state-10c');
    mockSuccessfulTokenExchange('cloud-happy-c', 'Happy Site C');

    await request(app)
      .get('/oauth/callback')
      .query({ code: 'auth-code-happy-c', state: 'happy-state-10c' })
      .redirects(0);

    const connections = [...db.connections.values()];
    expect(connections).toHaveLength(1);

    const conn = connections[0];
    // Tokens must NOT be stored as plaintext
    expect(conn.accessToken).not.toBe('at-sprint10');
    expect(conn.refreshToken).not.toBe('rt-sprint10');
    // Encrypted format: salt.iv.ciphertext (3 dot-separated base64 segments)
    expect(conn.accessToken.split('.')).toHaveLength(3);
    expect(conn.refreshToken.split('.')).toHaveLength(3);
  });

  test('state record is consumed (one-time use) after successful callback', async () => {
    seedPendingState('happy-state-10d');
    mockSuccessfulTokenExchange('cloud-happy-d', 'Happy Site D');

    await request(app)
      .get('/oauth/callback')
      .query({ code: 'auth-code-happy-d', state: 'happy-state-10d' })
      .redirects(0);

    // State must be deleted after first use
    expect(db.pendingStates.get('happy-state-10d')).toBeUndefined();
  });
});

// ============================================================
// TC-2: cloudId resolution via /oauth/callback
// ============================================================
describe('TC-2: cloudId resolved from accessible-resources after token exchange', () => {
  test('cloudId from accessible-resources is stored in the connection record', async () => {
    seedPendingState('cloudid-state-10');
    mockSuccessfulTokenExchange('cloud-resolved-xyz', 'Resolved Site');

    await request(app)
      .get('/oauth/callback')
      .query({ code: 'auth-code-cloud', state: 'cloudid-state-10' })
      .redirects(0);

    const connections = [...db.connections.values()];
    expect(connections).toHaveLength(1);
    expect(connections[0].cloudId).toBe('cloud-resolved-xyz');
    expect(connections[0].siteName).toBe('Resolved Site');
  });

  test('CloudSite record is created with the resolved cloudId', async () => {
    seedPendingState('cloudid-state-10b');
    mockSuccessfulTokenExchange('cloud-site-xyz', 'Site XYZ');

    await request(app)
      .get('/oauth/callback')
      .query({ code: 'auth-code-cloud-b', state: 'cloudid-state-10b' })
      .redirects(0);

    const cloudSites = [...db.cloudSites.values()];
    expect(cloudSites).toHaveLength(1);
    expect(cloudSites[0].cloudId).toBe('cloud-site-xyz');
    expect(cloudSites[0].connectionId).toBe([...db.connections.values()][0].id);
  });

  test('connectionId in redirect URL matches the stored connection record', async () => {
    seedPendingState('cloudid-state-10c');
    mockSuccessfulTokenExchange('cloud-match', 'Match Site');

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'auth-code-cloud-c', state: 'cloudid-state-10c' })
      .redirects(0);

    const connections = [...db.connections.values()];
    expect(connections).toHaveLength(1);
    expect(res.headers.location).toContain(connections[0].id);
  });

  test('accessible-resources is called with the access token from token exchange', async () => {
    seedPendingState('cloudid-state-10d');
    mockSuccessfulTokenExchange('cloud-at-check', 'AT Check Site');

    await request(app)
      .get('/oauth/callback')
      .query({ code: 'auth-code-cloud-d', state: 'cloudid-state-10d' })
      .redirects(0);

    // axios.get should have been called for accessible-resources
    expect(axios.get).toHaveBeenCalledTimes(1);
    const [url, config] = axios.get.mock.calls[0];
    expect(url).toContain('accessible-resources');
    expect(config.headers.Authorization).toContain('Bearer');
  });
});

// ============================================================
// TC-3: Invalid / tampered state parameter
// ============================================================
describe('TC-3: Invalid/tampered state — no token exchange, clear error redirect', () => {
  test('unknown state param → redirect with STATE_INVALID, no connection stored', async () => {
    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'code-xyz', state: 'completely-fake-state-abc123' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('STATE_INVALID');
    // No token exchange should have occurred
    expect(axios.post).not.toHaveBeenCalled();
    // No connection stored
    expect(db.connections.size).toBe(0);
  });

  test('missing state param entirely → redirect with STATE_INVALID', async () => {
    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'code-no-state' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('STATE_INVALID');
    expect(db.connections.size).toBe(0);
  });

  test('missing code param entirely → redirect with STATE_INVALID', async () => {
    seedPendingState('state-no-code-10');

    const res = await request(app)
      .get('/oauth/callback')
      .query({ state: 'state-no-code-10' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('STATE_INVALID');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('expired state → pruned before lookup, redirect with STATE_INVALID, no connection stored', async () => {
    // db.pruneExpiredStates() runs at the top of the callback handler and removes
    // expired states before the lookup — so an already-expired state is pruned
    // and then appears as "not found", producing STATE_INVALID (not STATE_EXPIRED).
    // The STATE_EXPIRED code path in oauth.js is a belt-and-suspenders check that
    // only fires if the state expires in the microseconds between prune and lookup.
    seedPendingState('expired-state-10', {
      expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
    });

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'code-expired', state: 'expired-state-10' })
      .redirects(0);

    expect(res.status).toBe(302);
    // Expired states are pruned first → state not found → STATE_INVALID
    expect(res.headers.location).toContain('status=error');
    const location = res.headers.location;
    const isStateError = location.includes('STATE_INVALID') || location.includes('STATE_EXPIRED');
    expect(isStateError).toBe(true);
    expect(axios.post).not.toHaveBeenCalled();
    expect(db.connections.size).toBe(0);
  });

  test('tampered state (differs by one character) → redirect with STATE_INVALID', async () => {
    seedPendingState('real-state-10e');

    // Tamper the state by appending a character
    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'code-tamper', state: 'real-state-10eX' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('STATE_INVALID');
    expect(db.connections.size).toBe(0);
  });
});

// ============================================================
// TC-4: Expired / invalid authorization code (token exchange failure)
// ============================================================
describe('TC-4: Expired/invalid code — graceful error, no unhandled exception', () => {
  test('token exchange failure (Atlassian returns 400) → redirect with TOKEN_EXCHANGE_FAILED', async () => {
    seedPendingState('fail-code-state-10');

    const atlassianError = new Error('invalid_grant');
    atlassianError.response = { status: 400, data: { error: 'invalid_grant', error_description: 'Code already used' } };
    axios.post.mockRejectedValueOnce(atlassianError);

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'reused-or-expired-code', state: 'fail-code-state-10' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('TOKEN_EXCHANGE_FAILED');
    // No connection stored
    expect(db.connections.size).toBe(0);
  });

  test('token exchange failure → does not throw unhandled exception (no 500 response)', async () => {
    seedPendingState('fail-code-state-10b');
    axios.post.mockRejectedValueOnce(new Error('Network timeout'));

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'timeout-code', state: 'fail-code-state-10b' })
      .redirects(0);

    // Must be a redirect, not a 500 JSON
    expect(res.status).toBe(302);
    expect(res.status).not.toBe(500);
    expect(res.body).not.toMatchObject({ error: 'INTERNAL_ERROR' });
  });

  test('reused code (state already consumed) → STATE_INVALID on second attempt', async () => {
    seedPendingState('reuse-state-10');
    mockSuccessfulTokenExchange('cloud-reuse', 'Reuse Site');

    // First attempt: succeeds, consumes state
    await request(app)
      .get('/oauth/callback')
      .query({ code: 'good-code', state: 'reuse-state-10' })
      .redirects(0);

    expect(db.connections.size).toBe(1);

    // Second attempt with same state: state was deleted after first use
    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'good-code', state: 'reuse-state-10' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('STATE_INVALID');
    // No second connection created
    expect(db.connections.size).toBe(1);
  });

  test('accessible-resources failure after token exchange → redirect with ACCESSIBLE_RESOURCES_FAILED', async () => {
    seedPendingState('res-fail-state-10');

    axios.post.mockResolvedValueOnce({
      data: { access_token: 'at-ok', refresh_token: 'rt-ok', expires_in: 3600, scope: ALL_SCOPES.join(' ') },
    });
    axios.get.mockRejectedValueOnce(new Error('Atlassian resources endpoint unreachable'));

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'code-resources-fail', state: 'res-fail-state-10' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('ACCESSIBLE_RESOURCES_FAILED');
    expect(db.connections.size).toBe(0);
  });
});

// ============================================================
// TC-5: Route availability — /oauth/callback must not 404
// ============================================================
describe('TC-5: Route /oauth/callback is registered and does not return 404', () => {
  test('GET /oauth/callback with valid params returns 302, not 404', async () => {
    seedPendingState('no-404-state-10');
    mockSuccessfulTokenExchange('cloud-no404', 'No404 Site');

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'auth-code-no404', state: 'no-404-state-10' })
      .redirects(0);

    expect(res.status).not.toBe(404);
    expect(res.body).not.toMatchObject({ error: 'NOT_FOUND' });
  });

  test('GET /oauth/callback with bad state still returns 302 redirect, not 404', async () => {
    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'any-code', state: 'nonexistent-state-xyz' })
      .redirects(0);

    // Must be a redirect — the route IS registered; handler manages the error
    expect(res.status).toBe(302);
    expect(res.status).not.toBe(404);
  });

  test('GET /oauth/callback with error param from Atlassian (user denied) returns 302, not 404', async () => {
    const res = await request(app)
      .get('/oauth/callback')
      .query({ error: 'access_denied', error_description: 'User denied the request' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('ACCESS_DENIED');
    expect(res.status).not.toBe(404);
  });

  test('canonical path /api/v1/oauth/express/callback still works (backward compat)', async () => {
    seedPendingState('compat-state-10');
    mockSuccessfulTokenExchange('cloud-compat', 'Compat Site');

    const res = await request(app)
      .get('/api/v1/oauth/express/callback')
      .query({ code: 'auth-code-compat', state: 'compat-state-10' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('status=success');
  });

  test('/oauth/express/callback alias also works via the /oauth mount', async () => {
    seedPendingState('express-alias-state-10');
    mockSuccessfulTokenExchange('cloud-express-alias', 'Express Alias Site');

    const res = await request(app)
      .get('/oauth/express/callback')
      .query({ code: 'auth-code-express-alias', state: 'express-alias-state-10' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('status=success');
  });
});

// ============================================================
// TC-6: HTTPS redirect URI — Caddy local dev URL accepted
// ============================================================
describe('TC-6: HTTPS redirect URI validation for Caddy local dev URL', () => {
  test('POST /oauth/express/redirect accepts https://localhost:4443/oauth/callback as redirect URI', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/express/redirect')
      .send({ userId: 'user-caddy-10', redirectUri: 'https://localhost:4443/oauth/callback' });

    expect(res.status).toBe(200);
    expect(res.body.authorizationUrl).toBeDefined();
    const url = new URL(res.body.authorizationUrl);
    expect(url.searchParams.get('redirect_uri')).toBe('https://localhost:4443/oauth/callback');
  });

  test('POST /oauth/express/redirect rejects http://localhost:4443/oauth/callback (not HTTPS)', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/express/redirect')
      .send({ userId: 'user-http-10', redirectUri: 'http://localhost:4443/oauth/callback' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REDIRECT_URI');
  });
});
