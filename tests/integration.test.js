'use strict';

/**
 * Integration Test Suite — OAuth Callback and Manage Endpoint
 *
 * Uses real env credentials loaded from .env.test (Atlassian calls are mocked).
 * Covers:
 *   TC-INT-1  Successful callback: connection stored, encrypted tokens, redirect to callback.html
 *   TC-INT-2  Callback redirect URL contains connectionId
 *   TC-INT-3  GET /api/v1/integrations/:connectionId returns cloudId, scopes, siteName
 *   TC-INT-4  Missing `code` param → error redirect (STATE_INVALID)
 *   TC-INT-5  Invalid/missing state → error redirect (STATE_INVALID)
 *   TC-INT-6  End-to-end: express/redirect → callback → manage API in one flow
 *
 * NOTE: The server-side OAuth callback redirects to /callback.html?connectionId=<id>&status=success.
 * The browser-side callback.html then navigates the user to /manage.html?connectionId=<id> after
 * completing scope validation and project-scope setup. These integration tests cover the server-side
 * redirect (to callback.html) and then separately test the manage endpoint directly.
 */

// ---------------------------------------------------------------------------
// Load credentials from .env.test (no secrets hard-coded in source)
// ---------------------------------------------------------------------------
(function loadEnvTest() {
  const fs = require('fs');
  const path = require('path');
  try {
    const content = fs.readFileSync(path.join(__dirname, '..', '.env.test'), 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) {
        // Only set if not already present in the environment (CI may inject directly)
        process.env[m[1]] = m[2].trim();
      }
    }
  } catch {
    // .env.test missing — rely on env vars already set (e.g. in CI)
  }
})();

jest.mock('axios');

const request = require('supertest');
const axios   = require('axios');
const app     = require('../src/app');
const db      = require('../src/db');
const { SCOPE_NAMES } = require('../src/services/scopeValidation');

const ALL_SCOPES = SCOPE_NAMES;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seed a valid pending OAuth state record as if POST /oauth/express/redirect ran.
 */
function seedState(stateId, overrides = {}) {
  db.pendingStates.set(stateId, {
    state:        stateId,
    codeVerifier: 'int-test-code-verifier',
    userId:       'int-test-user',
    redirectUri:  process.env.ATLASSIAN_REDIRECT_URI,
    path:         'express',
    expiresAt:    new Date(Date.now() + 600_000).toISOString(),
    ...overrides,
  });
}

/**
 * Mock a successful Atlassian token exchange followed by accessible-resources.
 */
function mockAtlassianSuccess({
  cloudId   = 'cloud-int-test-01',
  siteName  = 'Integration Test Site',
  siteUrl   = 'https://cloud-int-test-01.atlassian.net',
} = {}) {
  axios.post.mockResolvedValueOnce({
    data: {
      access_token:  'int-at-secret',
      refresh_token: 'int-rt-secret',
      expires_in:    3600,
      scope:         ALL_SCOPES.join(' '),
    },
  });
  axios.get.mockResolvedValueOnce({
    data: [{
      id:       cloudId,
      name:     siteName,
      url:      siteUrl,
      scopes:   ALL_SCOPES,
      avatarUrl: null,
    }],
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

// ===========================================================================
// TC-INT-1: Successful callback stores connection with encrypted tokens
// ===========================================================================
describe('TC-INT-1: Successful callback — connection stored, tokens encrypted', () => {
  test('returns 302 (not 404 or 500), mocked token exchange called with client_id from .env.test', async () => {
    seedState('int-state-tc1a');
    mockAtlassianSuccess();

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'int-auth-code-tc1a', state: 'int-state-tc1a' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.status).not.toBe(404);

    // Token exchange must have been called with the real client_id from .env.test
    expect(axios.post).toHaveBeenCalledTimes(1);
    const postBody = axios.post.mock.calls[0][1];
    expect(postBody.client_id).toBe(process.env.ATLASSIAN_CLIENT_ID);
    expect(postBody.redirect_uri).toBe(process.env.ATLASSIAN_REDIRECT_URI);
  });

  test('connection record is stored in db after successful callback', async () => {
    seedState('int-state-tc1b');
    mockAtlassianSuccess({ cloudId: 'cloud-stored-check', siteName: 'Stored Site' });

    await request(app)
      .get('/oauth/callback')
      .query({ code: 'int-auth-code-tc1b', state: 'int-state-tc1b' })
      .redirects(0);

    expect(db.connections.size).toBe(1);
    const conn = [...db.connections.values()][0];
    expect(conn.cloudId).toBe('cloud-stored-check');
    expect(conn.siteName).toBe('Stored Site');
    expect(conn.status).toBe('active');
    expect(conn.userId).toBe('int-test-user');
  });

  test('access_token and refresh_token are stored encrypted (not as plaintext)', async () => {
    seedState('int-state-tc1c');
    mockAtlassianSuccess();

    await request(app)
      .get('/oauth/callback')
      .query({ code: 'int-auth-code-tc1c', state: 'int-state-tc1c' })
      .redirects(0);

    const conn = [...db.connections.values()][0];

    // Plaintext tokens must NOT appear
    expect(conn.accessToken).not.toBe('int-at-secret');
    expect(conn.refreshToken).not.toBe('int-rt-secret');

    // Encrypted format: salt.iv.ciphertext (3 dot-separated segments)
    expect(conn.accessToken.split('.')).toHaveLength(3);
    expect(conn.refreshToken.split('.')).toHaveLength(3);
  });

  test('all 20 granted scopes are stored in the connection record', async () => {
    seedState('int-state-tc1d');
    mockAtlassianSuccess();

    await request(app)
      .get('/oauth/callback')
      .query({ code: 'int-auth-code-tc1d', state: 'int-state-tc1d' })
      .redirects(0);

    const conn = [...db.connections.values()][0];
    expect(conn.grantedScopes).toEqual(expect.arrayContaining(ALL_SCOPES));
    expect(conn.grantedScopes).toHaveLength(ALL_SCOPES.length);
  });

  test('CloudSite record is created and linked to the connection', async () => {
    seedState('int-state-tc1e');
    mockAtlassianSuccess({ cloudId: 'cloud-site-link', siteName: 'Site Link' });

    await request(app)
      .get('/oauth/callback')
      .query({ code: 'int-auth-code-tc1e', state: 'int-state-tc1e' })
      .redirects(0);

    const cloudSites = [...db.cloudSites.values()];
    expect(cloudSites).toHaveLength(1);
    expect(cloudSites[0].cloudId).toBe('cloud-site-link');

    const conn = [...db.connections.values()][0];
    expect(cloudSites[0].connectionId).toBe(conn.id);
  });
});

// ===========================================================================
// TC-INT-2: Callback redirect URL shape
// ===========================================================================
describe('TC-INT-2: Callback redirect URL — connectionId present in location header', () => {
  test('redirect location is /callback.html (server-side) with status=success', async () => {
    seedState('int-state-tc2a');
    mockAtlassianSuccess();

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'int-code-tc2a', state: 'int-state-tc2a' })
      .redirects(0);

    expect(res.status).toBe(302);
    // Server redirects to /callback.html — the browser-side page then navigates to manage.html
    expect(res.headers.location).toMatch(/^\/callback\.html\?/);
    expect(res.headers.location).toContain('status=success');
  });

  test('connectionId in redirect URL matches stored connection record id', async () => {
    seedState('int-state-tc2b');
    mockAtlassianSuccess({ cloudId: 'cloud-id-match' });

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'int-code-tc2b', state: 'int-state-tc2b' })
      .redirects(0);

    const conn = [...db.connections.values()][0];
    expect(res.headers.location).toContain(conn.id);
  });

  test('redirect URL does not contain status=error on success', async () => {
    seedState('int-state-tc2c');
    mockAtlassianSuccess();

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'int-code-tc2c', state: 'int-state-tc2c' })
      .redirects(0);

    expect(res.headers.location).not.toContain('status=error');
  });
});

// ===========================================================================
// TC-INT-3: GET /api/v1/integrations/:connectionId — manage endpoint
// ===========================================================================
describe('TC-INT-3: Manage endpoint — returns connection metadata', () => {
  test('returns 200 with cloudId, siteName, and grantedScopes for a valid connectionId', async () => {
    // First, establish a connection via the callback
    seedState('int-state-tc3a');
    mockAtlassianSuccess({ cloudId: 'cloud-manage-tc3', siteName: 'Manage Test Site' });

    await request(app)
      .get('/oauth/callback')
      .query({ code: 'int-code-tc3a', state: 'int-state-tc3a' })
      .redirects(0);

    const conn = [...db.connections.values()][0];

    // Now call the manage endpoint
    const manageRes = await request(app)
      .get(`/api/v1/integrations/${conn.id}`);

    expect(manageRes.status).toBe(200);
    expect(manageRes.body.connectionId).toBe(conn.id);
    expect(manageRes.body.cloudId).toBe('cloud-manage-tc3');
    expect(manageRes.body.siteName).toBe('Manage Test Site');
    expect(manageRes.body.grantedScopes).toEqual(expect.arrayContaining(ALL_SCOPES));
  });

  test('manage endpoint returns status=active when all required scopes granted', async () => {
    seedState('int-state-tc3b');
    mockAtlassianSuccess({ cloudId: 'cloud-status-tc3' });

    await request(app)
      .get('/oauth/callback')
      .query({ code: 'int-code-tc3b', state: 'int-state-tc3b' })
      .redirects(0);

    const conn = [...db.connections.values()][0];
    const manageRes = await request(app).get(`/api/v1/integrations/${conn.id}`);

    expect(manageRes.status).toBe(200);
    expect(manageRes.body.status).toBe('active');
    expect(manageRes.body.boardScopeDegraded).toBe(false);
  });

  test('manage endpoint returns 404 for an unknown connectionId', async () => {
    const manageRes = await request(app)
      .get('/api/v1/integrations/non-existent-id-xyz');

    expect(manageRes.status).toBe(404);
    expect(manageRes.body.error).toBe('CONNECTION_NOT_FOUND');
  });

  test('manage endpoint returns siteUrl alongside cloudId and siteName', async () => {
    seedState('int-state-tc3c');
    mockAtlassianSuccess({
      cloudId:  'cloud-url-tc3',
      siteName: 'URL Test Site',
      siteUrl:  'https://cloud-url-tc3.atlassian.net',
    });

    await request(app)
      .get('/oauth/callback')
      .query({ code: 'int-code-tc3c', state: 'int-state-tc3c' })
      .redirects(0);

    const conn = [...db.connections.values()][0];
    const manageRes = await request(app).get(`/api/v1/integrations/${conn.id}`);

    expect(manageRes.status).toBe(200);
    expect(manageRes.body.siteUrl).toBe('https://cloud-url-tc3.atlassian.net');
  });
});

// ===========================================================================
// TC-INT-4: Missing `code` parameter → error redirect
// ===========================================================================
describe('TC-INT-4: Missing code param → error redirect, no connection stored', () => {
  test('GET /oauth/callback with no code → 302 with STATE_INVALID error', async () => {
    seedState('int-state-tc4a');

    const res = await request(app)
      .get('/oauth/callback')
      .query({ state: 'int-state-tc4a' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('STATE_INVALID');
    expect(axios.post).not.toHaveBeenCalled();
    expect(db.connections.size).toBe(0);
  });

  test('GET /oauth/callback with empty code value → 302 with STATE_INVALID error', async () => {
    seedState('int-state-tc4b');

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: '', state: 'int-state-tc4b' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('STATE_INVALID');
    expect(db.connections.size).toBe(0);
  });

  test('GET /oauth/callback with no code AND no state → 302 with STATE_INVALID error', async () => {
    const res = await request(app)
      .get('/oauth/callback')
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('STATE_INVALID');
    expect(db.connections.size).toBe(0);
  });
});

// ===========================================================================
// TC-INT-5: Invalid state → error redirect, no token exchange attempted
// ===========================================================================
describe('TC-INT-5: Invalid state → error redirect, no tokens exchanged', () => {
  test('completely unknown state → 302 with STATE_INVALID, no token exchange', async () => {
    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'int-valid-looking-code', state: 'totally-fake-state-int-xyz' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('STATE_INVALID');
    expect(axios.post).not.toHaveBeenCalled();
    expect(db.connections.size).toBe(0);
  });

  test('tampered state (real state + extra char) → STATE_INVALID, no connection created', async () => {
    seedState('int-real-state-tc5');

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'int-code-tamper', state: 'int-real-state-tc5-TAMPERED' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('STATE_INVALID');
    expect(db.connections.size).toBe(0);
  });

  test('expired state → pruned before lookup → STATE_INVALID redirect', async () => {
    seedState('int-expired-state-tc5', {
      expiresAt: new Date(Date.now() - 5000).toISOString(), // already expired
    });

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'int-code-expired', state: 'int-expired-state-tc5' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('status=error');
    const loc = res.headers.location;
    expect(loc.includes('STATE_INVALID') || loc.includes('STATE_EXPIRED')).toBe(true);
    expect(axios.post).not.toHaveBeenCalled();
    expect(db.connections.size).toBe(0);
  });

  test('Atlassian error param (user denied) → 302 with ACCESS_DENIED', async () => {
    const res = await request(app)
      .get('/oauth/callback')
      .query({ error: 'access_denied', error_description: 'User denied auth' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('ACCESS_DENIED');
    expect(db.connections.size).toBe(0);
  });
});

// ===========================================================================
// TC-INT-6: End-to-end: express/redirect → callback → manage API
// ===========================================================================
describe('TC-INT-6: End-to-end OAuth flow — redirect initiation to manage metadata', () => {
  test('full flow: POST express/redirect → GET callback → GET manage returns metadata', async () => {
    // Step 1: Initiate Express OAuth redirect
    const redirectRes = await request(app)
      .post('/api/v1/oauth/express/redirect')
      .send({
        userId:      'e2e-int-user',
        redirectUri: process.env.ATLASSIAN_REDIRECT_URI,
      });

    expect(redirectRes.status).toBe(200);
    expect(redirectRes.body.authorizationUrl).toContain('auth.atlassian.com');
    expect(redirectRes.body.state).toBeDefined();

    const { state } = redirectRes.body;

    // Step 2: Mock Atlassian token exchange + accessible-resources
    mockAtlassianSuccess({ cloudId: 'cloud-e2e-01', siteName: 'E2E Site' });

    // Step 3: Simulate callback from Atlassian
    const callbackRes = await request(app)
      .get('/oauth/callback')
      .query({ code: 'e2e-auth-code', state })
      .redirects(0);

    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toContain('status=success');

    // Extract connectionId from redirect URL
    const locUrl = new URL(callbackRes.headers.location, 'http://localhost');
    const connectionId = locUrl.searchParams.get('connectionId');
    expect(connectionId).toBeTruthy();

    // Step 4: Verify connection is stored
    expect(db.connections.has(connectionId)).toBe(true);

    // Step 5: Call manage endpoint — should return full metadata
    const manageRes = await request(app)
      .get(`/api/v1/integrations/${connectionId}`);

    expect(manageRes.status).toBe(200);
    expect(manageRes.body.connectionId).toBe(connectionId);
    expect(manageRes.body.cloudId).toBe('cloud-e2e-01');
    expect(manageRes.body.siteName).toBe('E2E Site');
    expect(manageRes.body.grantedScopes).toEqual(expect.arrayContaining(ALL_SCOPES));
    expect(manageRes.body.status).toBe('active');
  });

  test('token exchange failure → callback redirects with error, manage endpoint returns 404', async () => {
    seedState('int-fail-e2e-state');

    const tokenError = new Error('invalid_grant');
    tokenError.response = { status: 400, data: { error: 'invalid_grant' } };
    axios.post.mockRejectedValueOnce(tokenError);

    const callbackRes = await request(app)
      .get('/oauth/callback')
      .query({ code: 'bad-code-e2e', state: 'int-fail-e2e-state' })
      .redirects(0);

    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toContain('TOKEN_EXCHANGE_FAILED');

    // No connection stored → manage endpoint returns 404
    expect(db.connections.size).toBe(0);

    const manageRes = await request(app)
      .get('/api/v1/integrations/any-nonexistent-id');

    expect(manageRes.status).toBe(404);
    expect(manageRes.body.error).toBe('CONNECTION_NOT_FOUND');
  });
});
