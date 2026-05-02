'use strict';

/**
 * Sprint 1 End-to-End Test Suite
 * Covers: Express path, Manual path, scope validation, multi-site selection,
 * graceful degradation, token expiry alerting, lifecycle (Soft/Hard Delete),
 * and project scope configuration.
 *
 * All external Atlassian API calls are mocked via jest.mock('axios').
 */

// ---------------------------------------------------------------------------
// Environment setup — MUST happen before any module is required
// because oauth.js reads these as module-level constants at load time.
// ---------------------------------------------------------------------------
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = 'aabbccddeeff00112233445566778899aabbccddeeff001122334455667788990011'.slice(0, 64);
process.env.ATLASSIAN_CLIENT_ID = 'test-client-id';
process.env.ATLASSIAN_CLIENT_SECRET = 'test-client-secret-xyz';
process.env.ATLASSIAN_REDIRECT_URI = 'https://example.com/callback';
process.env.ALLOW_HARD_DELETE = 'true';
process.env.NODE_ENV = 'test';
process.env.INTEGRATION_SOFT_DELETE_RETENTION_DAYS = '30';

// ---------------------------------------------------------------------------
// Mocks — jest.mock is hoisted but process.env assignments above run first
// because they are plain statements (not hoisted by the transformer).
// ---------------------------------------------------------------------------
jest.mock('axios');

const request = require('supertest');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = require('../src/app');
const db = require('../src/db');
const { SCOPE_NAMES, SCOPE_MATRIX } = require('../src/services/scopeValidation');
const { encrypt } = require('../src/services/crypto');

// ---------------------------------------------------------------------------
// Scope constants
// ---------------------------------------------------------------------------
const ALL_SCOPES = SCOPE_NAMES; // 21 scopes (19 required + 2 optional board scopes)
const BOARD_OPTIONAL_SCOPES = ['read:board-scope:jira-software', 'write:board-scope:jira-software'];
const ALL_REQUIRED_SCOPES = SCOPE_NAMES.filter((s) => !BOARD_OPTIONAL_SCOPES.includes(s));

// ---------------------------------------------------------------------------
// Test helper: seed a finalized OAuthConnection directly into the in-memory db
// ---------------------------------------------------------------------------
function makeConnection(overrides = {}) {
  const id = uuidv4();
  const now = new Date();
  const conn = {
    id,
    userId: 'user-fixture',
    cloudId: 'cloud-fixture',
    siteName: 'Fixture Site',
    siteUrl: 'https://fixture.atlassian.net',
    accessToken: encrypt('fixture-access-token'),
    refreshToken: encrypt('fixture-refresh-token'),
    accessTokenExpiresAt: new Date(now.getTime() + 3600 * 1000).toISOString(),
    refreshTokenLastUsedAt: now.toISOString(),
    refreshTokenExpiresAt: null,
    clientId: null,
    clientSecret: null,
    connectionPath: 'express',
    grantedScopes: ALL_SCOPES,
    missingRequiredScopes: [],
    boardScopeDegraded: false,
    status: 'active',
    connectedAt: now.toISOString(),
    lastSyncedAt: null,
    softDeletedAt: null,
    hardDeletedAt: null,
    softDeleteRetentionDays: 30,
    projectScopeMode: 'all',
    selectedProjectIds: [],
    includeArchivedProjects: false,
    refreshExpiryAlertSentAt: null,
    refreshExpiredBannerDismissedAt: null,
    sandbox: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
  db.connections.set(id, conn);
  return conn;
}

// ---------------------------------------------------------------------------
// Clear all in-memory state before each test
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
// 1. EXPRESS PATH — REDIRECT URL
// ============================================================
describe('Express OAuth path — redirect URL', () => {
  test('generates auth URL with response_type=code, client_id, redirect_uri, and all 21 scopes', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/express/redirect')
      .send({ userId: 'user-1', redirectUri: 'https://example.com/callback' });

    expect(res.status).toBe(200);
    expect(res.body.authorizationUrl).toBeDefined();
    expect(res.body.state).toBeDefined();
    expect(res.body.expiresAt).toBeDefined();

    const url = new URL(res.body.authorizationUrl);
    expect(url.hostname).toBe('auth.atlassian.com');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('audience')).toBe('api.atlassian.com');

    const scopesInUrl = url.searchParams.get('scope').split(' ');
    expect(scopesInUrl).toHaveLength(21);
    for (const scope of ALL_SCOPES) {
      expect(scopesInUrl).toContain(scope);
    }
  });

  test('stores pending state keyed by the returned state value', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/express/redirect')
      .send({ userId: 'user-1', redirectUri: 'https://example.com/callback' });

    expect(res.status).toBe(200);
    const { state } = res.body;
    const stored = db.pendingStates.get(state);
    expect(stored).toBeDefined();
    expect(stored.userId).toBe('user-1');
    expect(stored.path).toBe('express');
    expect(stored.codeVerifier).toBeDefined();
  });

  test('returns 400 when userId is missing', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/express/redirect')
      .send({ redirectUri: 'https://example.com/callback' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_USER_ID');
  });

  test('returns 400 when redirectUri is not HTTPS', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/express/redirect')
      .send({ userId: 'user-1', redirectUri: 'http://example.com/callback' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REDIRECT_URI');
  });
});

// ============================================================
// 2. EXPRESS PATH — CALLBACK HANDLER (single site)
// ============================================================
describe('Express OAuth callback — single site auto-select', () => {
  function seedPendingState(stateId = 'test-state', overrides = {}) {
    db.pendingStates.set(stateId, {
      state: stateId,
      codeVerifier: 'test-code-verifier',
      userId: 'user-callback',
      redirectUri: 'https://example.com/callback',
      path: 'express',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      ...overrides,
    });
  }

  test('happy path: exchanges code, resolves cloudId, stores encrypted tokens, redirects to success', async () => {
    seedPendingState('cb-state-1');

    axios.post.mockResolvedValue({
      data: {
        access_token: 'at-mock-1',
        refresh_token: 'rt-mock-1',
        expires_in: 3600,
        scope: ALL_SCOPES.join(' '),
      },
    });
    axios.get.mockResolvedValue({
      data: [
        { id: 'cloud-abc', name: 'Acme Jira', url: 'https://acme.atlassian.net', scopes: ALL_SCOPES, avatarUrl: null },
      ],
    });

    const res = await request(app)
      .get('/api/v1/oauth/express/callback')
      .query({ code: 'authcode-1', state: 'cb-state-1' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('status=success');
    expect(res.headers.location).not.toContain('requiresSiteSelection');

    // Connection stored
    const connections = [...db.connections.values()];
    expect(connections).toHaveLength(1);
    const conn = connections[0];
    expect(conn.cloudId).toBe('cloud-abc');
    expect(conn.siteName).toBe('Acme Jira');
    expect(conn.userId).toBe('user-callback');
    expect(conn.connectionPath).toBe('express');

    // Tokens must be encrypted (not plaintext)
    expect(conn.accessToken).not.toBe('at-mock-1');
    expect(conn.refreshToken).not.toBe('rt-mock-1');
    // Encrypted format: base64(salt).base64(iv).base64(ciphertext+tag)
    expect(conn.accessToken.split('.')).toHaveLength(3);

    // CloudSite stored
    const sites = [...db.cloudSites.values()];
    expect(sites).toHaveLength(1);
    expect(sites[0].cloudId).toBe('cloud-abc');
    expect(sites[0].connectionId).toBe(conn.id);

    // connectionId present in redirect
    expect(res.headers.location).toContain(conn.id);
  });

  test('redirects with error on unknown state', async () => {
    const res = await request(app)
      .get('/api/v1/oauth/express/callback')
      .query({ code: 'any-code', state: 'nonexistent-state' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('status=error');
    expect(res.headers.location).toContain('STATE_INVALID');
  });

  test('redirects with ACCESS_DENIED when Atlassian sends error param', async () => {
    const res = await request(app)
      .get('/api/v1/oauth/express/callback')
      .query({ error: 'access_denied', error_description: 'User denied' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('ACCESS_DENIED');
  });

  test('redirects with TOKEN_EXCHANGE_FAILED when axios.post throws', async () => {
    seedPendingState('cb-state-fail');
    axios.post.mockRejectedValue(new Error('Token endpoint unreachable'));

    const res = await request(app)
      .get('/api/v1/oauth/express/callback')
      .query({ code: 'code', state: 'cb-state-fail' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('TOKEN_EXCHANGE_FAILED');
  });
});

// ============================================================
// 3. MANUAL OAUTH PATH
// ============================================================
describe('Manual OAuth path', () => {
  const VALID_BODY = {
    clientId: 'manual-client-id-xyz',
    clientSecret: 'manual-secret-at-least-16chars',
    siteUrl: 'https://mycompany.atlassian.net',
    redirectUri: 'https://myapp.example.com/callback',
  };

  test('valid credentials return authorization URL with all 20 scopes and confirmation details', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/manual/connect')
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.authorizationUrl).toContain('https://auth.atlassian.com/authorize');
    expect(res.body.state).toBeDefined();

    const url = new URL(res.body.authorizationUrl);
    expect(url.searchParams.get('client_id')).toBe(VALID_BODY.clientId);
    const scopesInUrl = url.searchParams.get('scope').split(' ');
    expect(scopesInUrl).toHaveLength(21);

    const { confirmationDetails } = res.body;
    expect(confirmationDetails).toBeDefined();
    expect(confirmationDetails.redirectUri).toBe(VALID_BODY.redirectUri);
    expect(confirmationDetails.siteUrl).toBe(VALID_BODY.siteUrl);
    expect(confirmationDetails.requestedScopes).toHaveLength(21);
    // clientId is masked
    expect(confirmationDetails.clientIdMasked).toMatch(/^\.\.\./);
  });

  test('returns 400 when clientId is missing', async () => {
    const { clientId: _omit, ...body } = VALID_BODY;
    const res = await request(app).post('/api/v1/oauth/manual/connect').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_CLIENT_ID');
  });

  test('returns 400 when clientSecret is shorter than 16 chars', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/manual/connect')
      .send({ ...VALID_BODY, clientSecret: 'tooshort' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_CLIENT_SECRET');
  });

  test('returns 400 when siteUrl is invalid', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/manual/connect')
      .send({ ...VALID_BODY, siteUrl: 'not-a-url' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SITE_URL');
  });

  test('returns 400 when redirectUri is not HTTPS', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/manual/connect')
      .send({ ...VALID_BODY, redirectUri: 'http://myapp.example.com/callback' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REDIRECT_URI');
  });
});

// ============================================================
// 4. SCOPE VALIDATION
// ============================================================
describe('Scope validation — POST /api/v1/oauth/scopes/validate', () => {
  test('all 21 scopes granted → overallStatus=PASS, connectionAllowed=true, all entries severity=OK', async () => {
    const conn = makeConnection({ grantedScopes: ALL_SCOPES });

    const res = await request(app)
      .post('/api/v1/oauth/scopes/validate')
      .send({ connectionId: conn.id });

    expect(res.status).toBe(200);
    expect(res.body.overallStatus).toBe('PASS');
    expect(res.body.connectionAllowed).toBe(true);
    expect(res.body.missingRequiredScopes).toHaveLength(0);
    expect(res.body.missingOptionalScopes).toHaveLength(0);
    expect(res.body.entries).toHaveLength(21);
    for (const entry of res.body.entries) {
      expect(entry.severity).toBe('OK');
      expect(entry.granted).toBe(true);
    }
  });

  test('one required scope missing → overallStatus=FAIL, connectionAllowed=false, red severity + remediation text', async () => {
    const missingScope = 'read:jira-work';
    const conn = makeConnection({ grantedScopes: ALL_SCOPES.filter((s) => s !== missingScope) });

    const res = await request(app)
      .post('/api/v1/oauth/scopes/validate')
      .send({ connectionId: conn.id });

    expect(res.status).toBe(200);
    expect(res.body.overallStatus).toBe('FAIL');
    expect(res.body.connectionAllowed).toBe(false);
    expect(res.body.missingRequiredScopes).toContain(missingScope);

    const entry = res.body.entries.find((e) => e.scope === missingScope);
    expect(entry.granted).toBe(false);
    expect(entry.severity).toBe('CRITICAL');
    expect(entry.remediationMessage).toBeTruthy();
    expect(entry.remediationMessage).toContain('Read Jira work data');
  });

  test('only board scope missing → overallStatus=DEGRADED, connectionAllowed=true, WARNING severity + non-blocking message', async () => {
    const conn = makeConnection({
      grantedScopes: ALL_SCOPES.filter((s) => s !== 'read:board-scope:jira-software'),
    });

    const res = await request(app)
      .post('/api/v1/oauth/scopes/validate')
      .send({ connectionId: conn.id });

    expect(res.status).toBe(200);
    expect(res.body.overallStatus).toBe('DEGRADED');
    expect(res.body.connectionAllowed).toBe(true);
    expect(res.body.missingRequiredScopes).toHaveLength(0);
    expect(res.body.missingOptionalScopes).toContain('read:board-scope:jira-software');

    const boardEntry = res.body.entries.find((e) => e.scope === 'read:board-scope:jira-software');
    expect(boardEntry.granted).toBe(false);
    expect(boardEntry.severity).toBe('WARNING');
    expect(boardEntry.remediationMessage).toContain('non-blocking');
    expect(res.body.degradedFeatures).toContain('boards');
  });

  test('board scope missing at callback time → connection proceeds, boardScopeDegraded=true, status=degraded', async () => {
    const state = 'board-degraded-state';
    db.pendingStates.set(state, {
      state,
      codeVerifier: 'verifier',
      userId: 'user-board',
      redirectUri: 'https://example.com/callback',
      path: 'express',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    const scopesWithoutBoard = ALL_SCOPES.filter((s) => s !== 'read:board-scope:jira-software');

    axios.post.mockResolvedValue({
      data: {
        access_token: 'at-board',
        refresh_token: 'rt-board',
        expires_in: 3600,
        scope: scopesWithoutBoard.join(' '),
      },
    });
    axios.get.mockResolvedValue({
      data: [{ id: 'cloud-board', name: 'Board Site', url: 'https://board.atlassian.net', scopes: scopesWithoutBoard }],
    });

    const res = await request(app)
      .get('/api/v1/oauth/express/callback')
      .query({ code: 'code-board', state })
      .redirects(0);

    // Connection is NOT blocked
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('status=success');

    const connections = [...db.connections.values()];
    expect(connections).toHaveLength(1);
    expect(connections[0].boardScopeDegraded).toBe(true);
    expect(connections[0].status).toBe('degraded');
  });

  test('missing a non-optional, non-board required scope blocks the connection at callback', async () => {
    const state = 'required-missing-state';
    db.pendingStates.set(state, {
      state,
      codeVerifier: 'verifier',
      userId: 'user-fail',
      redirectUri: 'https://example.com/callback',
      path: 'express',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    // Remove a required scope
    const incompleteScopes = ALL_SCOPES.filter((s) => s !== 'offline_access');

    axios.post.mockResolvedValue({
      data: {
        access_token: 'at-fail',
        refresh_token: 'rt-fail',
        expires_in: 3600,
        scope: incompleteScopes.join(' '),
      },
    });
    axios.get.mockResolvedValue({
      data: [{ id: 'cloud-fail', name: 'Fail Site', url: 'https://fail.atlassian.net', scopes: incompleteScopes }],
    });

    const res = await request(app)
      .get('/api/v1/oauth/express/callback')
      .query({ code: 'code-fail', state })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('SCOPE_VALIDATION_FAILED');
    expect(db.connections.size).toBe(0);
  });

  test('returns 404 when connectionId not found', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/scopes/validate')
      .send({ connectionId: 'nonexistent-id' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('CONNECTION_NOT_FOUND');
  });
});

// ============================================================
// 5. MULTI-SITE SELECTION
// ============================================================
describe('Multi-site selection', () => {
  const THREE_SITES = [
    { id: 'cloud-alpha', name: 'Site Alpha', url: 'https://alpha.atlassian.net', scopes: ALL_SCOPES, avatarUrl: 'https://cdn/alpha.png' },
    { id: 'cloud-beta', name: 'Site Beta', url: 'https://beta.atlassian.net', scopes: ALL_SCOPES, avatarUrl: null },
    { id: 'cloud-gamma', name: 'Site Gamma', url: 'https://gamma.atlassian.net', scopes: ALL_SCOPES, avatarUrl: null },
  ];

  test('3 accessible sites → callback sets requiresSiteSelection=true, GET /sites shows dropdown of 3 with autoSelected=false', async () => {
    const state = 'multi-3-state';
    db.pendingStates.set(state, {
      state,
      codeVerifier: 'verifier',
      userId: 'user-multi',
      redirectUri: 'https://example.com/callback',
      path: 'express',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    axios.post.mockResolvedValue({
      data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: ALL_SCOPES.join(' ') },
    });
    axios.get.mockResolvedValue({ data: THREE_SITES });

    const callbackRes = await request(app)
      .get('/api/v1/oauth/express/callback')
      .query({ code: 'code-multi', state })
      .redirects(0);

    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toContain('requiresSiteSelection=true');

    const redirectUrl = new URL(callbackRes.headers.location, 'http://localhost');
    const connectionId = redirectUrl.searchParams.get('connectionId');
    expect(connectionId).toBeTruthy();

    // No finalized connection yet
    expect(db.connections.size).toBe(0);

    // GET /sites should show all 3 as a dropdown
    const sitesRes = await request(app)
      .get('/api/v1/oauth/sites')
      .query({ connectionId });

    expect(sitesRes.status).toBe(200);
    expect(sitesRes.body.sites).toHaveLength(3);
    expect(sitesRes.body.autoSelected).toBe(false);
    expect(sitesRes.body.selectedCloudId).toBeNull();

    const names = sitesRes.body.sites.map((s) => s.name);
    expect(names).toContain('Site Alpha');
    expect(names).toContain('Site Beta');
    expect(names).toContain('Site Gamma');
  });

  test('1 accessible site → callback auto-selects and GET /sites shows read-only site with autoSelected=true', async () => {
    const state = 'single-site-state';
    db.pendingStates.set(state, {
      state,
      codeVerifier: 'verifier',
      userId: 'user-single',
      redirectUri: 'https://example.com/callback',
      path: 'express',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    axios.post.mockResolvedValue({
      data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: ALL_SCOPES.join(' ') },
    });
    axios.get.mockResolvedValue({ data: [THREE_SITES[0]] });

    const callbackRes = await request(app)
      .get('/api/v1/oauth/express/callback')
      .query({ code: 'code-single', state })
      .redirects(0);

    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).not.toContain('requiresSiteSelection');
    expect(callbackRes.headers.location).toContain('status=success');

    // Connection finalized directly
    const connections = [...db.connections.values()];
    expect(connections).toHaveLength(1);
    expect(connections[0].cloudId).toBe('cloud-alpha');

    const connectionId = connections[0].id;
    const sitesRes = await request(app)
      .get('/api/v1/oauth/sites')
      .query({ connectionId });

    expect(sitesRes.status).toBe(200);
    expect(sitesRes.body.autoSelected).toBe(true);
    expect(sitesRes.body.selectedCloudId).toBe('cloud-alpha');
    expect(sitesRes.body.sites).toHaveLength(1);
  });

  test('POST /sites/select finalizes connection for chosen site and stores CloudSite', async () => {
    const pendingId = uuidv4();
    db.pendingStates.set(`pending_conn_${pendingId}`, {
      type: 'pending_connection',
      connectionId: pendingId,
      userId: 'user-select',
      accessToken: 'at-select',
      refreshToken: 'rt-select',
      accessTokenExpiresIn: 3600,
      grantedScopes: ALL_SCOPES,
      validationResult: {
        missingRequiredScopes: [],
        missingOptionalScopes: [],
        degradedFeatures: [],
        overallStatus: 'PASS',
        connectionAllowed: true,
      },
      sites: THREE_SITES,
      connectionPath: 'express',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });

    const res = await request(app)
      .post('/api/v1/oauth/sites/select')
      .send({ connectionId: pendingId, cloudId: 'cloud-beta' });

    expect(res.status).toBe(200);
    expect(res.body.cloudId).toBe('cloud-beta');
    expect(res.body.siteName).toBe('Site Beta');
    expect(res.body.status).toBe('active');
    expect(res.body.boardScopeDegraded).toBe(false);

    const conn = db.connections.get(res.body.connectionId);
    expect(conn).toBeDefined();
    expect(conn.cloudId).toBe('cloud-beta');

    const cloudSites = [...db.cloudSites.values()];
    expect(cloudSites).toHaveLength(1);
    expect(cloudSites[0].cloudId).toBe('cloud-beta');
  });

  test('POST /sites/select returns 400 for a cloudId not in the accessible sites list', async () => {
    const pendingId = uuidv4();
    db.pendingStates.set(`pending_conn_${pendingId}`, {
      type: 'pending_connection',
      connectionId: pendingId,
      userId: 'user-select-bad',
      accessToken: 'at',
      refreshToken: 'rt',
      accessTokenExpiresIn: 3600,
      grantedScopes: ALL_SCOPES,
      validationResult: { missingRequiredScopes: [], missingOptionalScopes: [], degradedFeatures: [], connectionAllowed: true },
      sites: THREE_SITES,
      connectionPath: 'express',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });

    const res = await request(app)
      .post('/api/v1/oauth/sites/select')
      .send({ connectionId: pendingId, cloudId: 'cloud-does-not-exist' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_CLOUD_ID');
  });
});

// ============================================================
// 6. REFRESH TOKEN EXPIRY
// ============================================================
describe('Refresh token expiry — GET /api/v1/integrations/:id/token-health', () => {
  test('token inactive >= 90 days → status=expired, daysRemaining=0', async () => {
    const lastUsed = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    const conn = makeConnection({ refreshTokenLastUsedAt: lastUsed.toISOString() });

    const res = await request(app).get(`/api/v1/integrations/${conn.id}/token-health`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('expired');
    expect(res.body.daysRemaining).toBe(0);
    expect(res.body.daysInactive).toBeGreaterThanOrEqual(91);
    expect(res.body.expiryDays).toBe(90);
  });

  test('token inactive 85 days (within 10-day proactive alert window) → status=expiring_soon', async () => {
    const lastUsed = new Date(Date.now() - 85 * 24 * 60 * 60 * 1000);
    const conn = makeConnection({ refreshTokenLastUsedAt: lastUsed.toISOString() });

    const res = await request(app).get(`/api/v1/integrations/${conn.id}/token-health`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('expiring_soon');
    expect(res.body.daysRemaining).toBeGreaterThan(0);
    expect(res.body.daysRemaining).toBeLessThanOrEqual(10);
    expect(res.body.daysInactive).toBeGreaterThanOrEqual(80);
    expect(res.body.daysInactive).toBeLessThan(90);
    expect(res.body.proactiveAlertThresholdDays).toBe(80);
  });

  test('token inactive < 80 days → status=healthy', async () => {
    const lastUsed = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const conn = makeConnection({ refreshTokenLastUsedAt: lastUsed.toISOString() });

    const res = await request(app).get(`/api/v1/integrations/${conn.id}/token-health`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.daysRemaining).toBeGreaterThan(10);
  });

  test('exactly at 80-day threshold → status=expiring_soon', async () => {
    const lastUsed = new Date(Date.now() - 80 * 24 * 60 * 60 * 1000);
    const conn = makeConnection({ refreshTokenLastUsedAt: lastUsed.toISOString() });

    const res = await request(app).get(`/api/v1/integrations/${conn.id}/token-health`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('expiring_soon');
  });

  test('returns 404 for deleted connection', async () => {
    const conn = makeConnection({ status: 'soft_deleted' });
    const res = await request(app).get(`/api/v1/integrations/${conn.id}/token-health`);
    expect(res.status).toBe(404);
  });
});

// ============================================================
// 7. SOFT DELETE
// ============================================================
describe('Soft Delete — DELETE /api/v1/integrations/:id', () => {
  test('soft delete sets softDeletedAt and scheduledPurgeAt = softDeletedAt + 30 days', async () => {
    const conn = makeConnection();
    const before = Date.now();

    const res = await request(app)
      .delete(`/api/v1/integrations/${conn.id}`)
      .send({ deleteMode: 'soft' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('soft_deleted');
    expect(res.body.deleteMode).toBe('soft');
    expect(res.body.retentionDays).toBe(30);
    expect(res.body.restorable).toBe(true);
    expect(res.body.softDeletedAt).toBeDefined();
    expect(res.body.scheduledPurgeAt).toBeDefined();

    const deletedAt = new Date(res.body.softDeletedAt);
    const purgeAt = new Date(res.body.scheduledPurgeAt);
    const diffDays = (purgeAt - deletedAt) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeCloseTo(30, 1);

    // Persisted in db
    const updated = db.connections.get(conn.id);
    expect(updated.status).toBe('soft_deleted');
    expect(updated.softDeletedAt).toBeDefined();
  });

  test('default deleteMode (no body field) is soft', async () => {
    const conn = makeConnection();
    const res = await request(app)
      .delete(`/api/v1/integrations/${conn.id}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.deleteMode).toBe('soft');
    expect(res.body.status).toBe('soft_deleted');
  });

  test('custom retentionDays is respected (capped at 90)', async () => {
    const conn = makeConnection();
    const res = await request(app)
      .delete(`/api/v1/integrations/${conn.id}`)
      .send({ deleteMode: 'soft', retentionDays: 14 });

    expect(res.status).toBe(200);
    expect(res.body.retentionDays).toBe(14);

    const deletedAt = new Date(res.body.softDeletedAt);
    const purgeAt = new Date(res.body.scheduledPurgeAt);
    const diffDays = (purgeAt - deletedAt) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeCloseTo(14, 1);
  });

  test('returns 409 when connection is already soft-deleted', async () => {
    const conn = makeConnection({ status: 'soft_deleted', softDeletedAt: new Date().toISOString() });
    const res = await request(app)
      .delete(`/api/v1/integrations/${conn.id}`)
      .send({ deleteMode: 'soft' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ALREADY_DELETED');
  });

  test('returns 404 for unknown connection', async () => {
    const res = await request(app)
      .delete(`/api/v1/integrations/nonexistent-uuid`)
      .send({ deleteMode: 'soft' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('CONNECTION_NOT_FOUND');
  });

  test('soft-deleted connection can be restored within retention window', async () => {
    const conn = makeConnection();

    // Soft-delete first
    await request(app)
      .delete(`/api/v1/integrations/${conn.id}`)
      .send({ deleteMode: 'soft' });

    // Restore
    const restoreRes = await request(app)
      .post(`/api/v1/integrations/${conn.id}/restore`);

    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.status).toBe('active');

    const updated = db.connections.get(conn.id);
    expect(updated.status).toBe('active');
    expect(updated.softDeletedAt).toBeNull();
  });
});

// ============================================================
// 8. HARD DELETE (sandbox-only)
// ============================================================
describe('Hard Delete — DELETE /api/v1/integrations/:id with deleteMode=hard', () => {
  test('non-sandbox connection (sandbox=false) returns 403 HARD_DELETE_NOT_ALLOWED', async () => {
    const conn = makeConnection({ sandbox: false });

    const res = await request(app)
      .delete(`/api/v1/integrations/${conn.id}`)
      .send({ deleteMode: 'hard' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('HARD_DELETE_NOT_ALLOWED');
    // Connection unchanged
    expect(db.connections.get(conn.id).status).toBe('active');
  });

  test('sandbox connection (sandbox=true) with ALLOW_HARD_DELETE=true succeeds', async () => {
    const conn = makeConnection({ sandbox: true });

    const res = await request(app)
      .delete(`/api/v1/integrations/${conn.id}`)
      .send({ deleteMode: 'hard' });

    expect(res.status).toBe(200);
    expect(res.body.deleteMode).toBe('hard');
    expect(res.body.status).toBe('hard_deleted');
    expect(res.body.restorable).toBe(false);
    expect(res.body.scheduledPurgeAt).toBeNull();

    const updated = db.connections.get(conn.id);
    expect(updated.status).toBe('hard_deleted');
    expect(updated.hardDeletedAt).toBeDefined();
  });

  test('hard delete rejected when ALLOW_HARD_DELETE env var is not "true"', async () => {
    const originalAllow = process.env.ALLOW_HARD_DELETE;
    process.env.ALLOW_HARD_DELETE = 'false';

    const conn = makeConnection({ sandbox: true });

    const res = await request(app)
      .delete(`/api/v1/integrations/${conn.id}`)
      .send({ deleteMode: 'hard' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('HARD_DELETE_NOT_ALLOWED');

    process.env.ALLOW_HARD_DELETE = originalAllow;
  });

  test('hard-deleted connection cannot be restored (409 NOT_SOFT_DELETED)', async () => {
    const conn = makeConnection({ sandbox: true });

    await request(app)
      .delete(`/api/v1/integrations/${conn.id}`)
      .send({ deleteMode: 'hard' });

    const restoreRes = await request(app)
      .post(`/api/v1/integrations/${conn.id}/restore`);

    expect(restoreRes.status).toBe(409);
    expect(restoreRes.body.error).toBe('NOT_SOFT_DELETED');
  });
});

// ============================================================
// 9. HTTPS REDIRECT URI VALIDATION (Sprint 8 — HTTPS onboarding fix)
// Validates that the HTTPS enforcement behaves exactly as documented in
// INSTALLATION.md, OAUTH_SETUP.md, and the USER_GUIDE for both paths.
// ============================================================
describe('HTTPS redirect URI validation — Express and Manual paths', () => {
  // ── Express path ─────────────────────────────────────────────────────────

  test('Express: ngrok-style URL (https://*.ngrok-free.app) is accepted', async () => {
    const ngrokUri = 'https://abc123.ngrok-free.app/oauth/callback';
    const res = await request(app)
      .post('/api/v1/oauth/express/redirect')
      .send({ userId: 'user-ngrok', redirectUri: ngrokUri });

    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizationUrl);
    expect(url.searchParams.get('redirect_uri')).toBe(ngrokUri);
  });

  test('Express: Caddy localhost HTTPS URL (https://localhost:4443) is accepted', async () => {
    const caddyUri = 'https://localhost:4443/oauth/callback';
    const res = await request(app)
      .post('/api/v1/oauth/express/redirect')
      .send({ userId: 'user-caddy', redirectUri: caddyUri });

    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizationUrl);
    expect(url.searchParams.get('redirect_uri')).toBe(caddyUri);
  });

  test('Express: HTTP-only URI returns the exact error message shown in troubleshooting docs', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/express/redirect')
      .send({ userId: 'user-http', redirectUri: 'http://localhost:4000/oauth/callback' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REDIRECT_URI');
    // Message must match the string documented in INSTALLATION.md troubleshooting table
    expect(res.body.message).toBe('Redirect URI must be a valid HTTPS URL');
  });

  test('Express: falls back to ATLASSIAN_REDIRECT_URI env var (HTTPS) when no redirectUri in body', async () => {
    // process.env.ATLASSIAN_REDIRECT_URI is set to 'https://example.com/callback' in test setup
    const res = await request(app)
      .post('/api/v1/oauth/express/redirect')
      .send({ userId: 'user-env-fallback' });

    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizationUrl);
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/callback');
  });

  test('Express: HTTPS URI with custom port is accepted (non-443)', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/express/redirect')
      .send({ userId: 'user-port', redirectUri: 'https://127.0.0.1:8443/oauth/callback' });

    expect(res.status).toBe(200);
    expect(res.body.authorizationUrl).toBeDefined();
  });

  // ── Manual path ──────────────────────────────────────────────────────────

  test('Manual: ngrok-style URL (https://*.ngrok-free.app) is accepted', async () => {
    const ngrokUri = 'https://abc123.ngrok-free.app/oauth/callback';
    const res = await request(app)
      .post('/api/v1/oauth/manual/connect')
      .send({
        clientId: 'manual-client-id-xyz',
        clientSecret: 'manual-secret-at-least-16chars',
        siteUrl: 'https://mycompany.atlassian.net',
        redirectUri: ngrokUri,
      });

    expect(res.status).toBe(200);
    expect(res.body.confirmationDetails.redirectUri).toBe(ngrokUri);
  });

  test('Manual: Caddy localhost HTTPS URL (https://localhost:4443) is accepted', async () => {
    const caddyUri = 'https://localhost:4443/oauth/callback';
    const res = await request(app)
      .post('/api/v1/oauth/manual/connect')
      .send({
        clientId: 'manual-client-id-xyz',
        clientSecret: 'manual-secret-at-least-16chars',
        siteUrl: 'https://mycompany.atlassian.net',
        redirectUri: caddyUri,
      });

    expect(res.status).toBe(200);
    expect(res.body.confirmationDetails.redirectUri).toBe(caddyUri);
  });

  test('Manual: HTTP-only URI is rejected with INVALID_REDIRECT_URI', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/manual/connect')
      .send({
        clientId: 'manual-client-id-xyz',
        clientSecret: 'manual-secret-at-least-16chars',
        siteUrl: 'https://mycompany.atlassian.net',
        redirectUri: 'http://localhost:4000/oauth/callback',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REDIRECT_URI');
    expect(res.body.message).toContain('HTTPS URL');
  });

  test('Manual: missing redirectUri is rejected with INVALID_REDIRECT_URI', async () => {
    const res = await request(app)
      .post('/api/v1/oauth/manual/connect')
      .send({
        clientId: 'manual-client-id-xyz',
        clientSecret: 'manual-secret-at-least-16chars',
        siteUrl: 'https://mycompany.atlassian.net',
        // redirectUri omitted
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REDIRECT_URI');
  });

  // ── Confirmation step: redirect URI forwarded to Atlassian exactly ────────

  test('Express: redirect_uri in Atlassian auth URL matches the HTTPS URI provided', async () => {
    const uri = 'https://stable.ngrok-free.app/oauth/callback';
    const res = await request(app)
      .post('/api/v1/oauth/express/redirect')
      .send({ userId: 'user-match', redirectUri: uri });

    expect(res.status).toBe(200);
    const authUrl = new URL(res.body.authorizationUrl);
    expect(authUrl.hostname).toBe('auth.atlassian.com');
    expect(authUrl.searchParams.get('redirect_uri')).toBe(uri);
  });

  test('Manual: redirect_uri in Atlassian auth URL matches the HTTPS URI provided', async () => {
    const uri = 'https://localhost:4443/oauth/callback';
    const res = await request(app)
      .post('/api/v1/oauth/manual/connect')
      .send({
        clientId: 'manual-client-id-xyz',
        clientSecret: 'manual-secret-at-least-16chars',
        siteUrl: 'https://mycompany.atlassian.net',
        redirectUri: uri,
      });

    expect(res.status).toBe(200);
    const authUrl = new URL(res.body.authorizationUrl);
    expect(authUrl.hostname).toBe('auth.atlassian.com');
    expect(authUrl.searchParams.get('redirect_uri')).toBe(uri);
  });
});

// ============================================================
// 10. PROJECT SCOPE CONFIGURATION
// ============================================================
describe('Project scope configuration — PATCH /api/v1/integrations/:id/project-scope', () => {
  test('new connection defaults: projectScopeMode=all, selectedProjectIds=[], includeArchivedProjects=false', async () => {
    const conn = makeConnection();
    expect(conn.projectScopeMode).toBe('all');
    expect(conn.selectedProjectIds).toEqual([]);
    expect(conn.includeArchivedProjects).toBe(false);
  });

  test('PATCH to selected mode with project IDs persists correctly', async () => {
    const conn = makeConnection();
    const projectIds = ['PROJ-1', 'PROJ-2', 'PROJ-3'];

    const res = await request(app)
      .patch(`/api/v1/integrations/${conn.id}/project-scope`)
      .send({ projectScopeMode: 'selected', selectedProjectIds: projectIds });

    expect(res.status).toBe(200);
    expect(res.body.projectScopeMode).toBe('selected');
    expect(res.body.selectedProjectIds).toEqual(projectIds);

    const updated = db.connections.get(conn.id);
    expect(updated.projectScopeMode).toBe('selected');
    expect(updated.selectedProjectIds).toEqual(projectIds);
  });

  test('PATCH enables includeArchivedProjects toggle', async () => {
    const conn = makeConnection();

    const res = await request(app)
      .patch(`/api/v1/integrations/${conn.id}/project-scope`)
      .send({ includeArchivedProjects: true });

    expect(res.status).toBe(200);
    expect(res.body.includeArchivedProjects).toBe(true);
    expect(db.connections.get(conn.id).includeArchivedProjects).toBe(true);
  });

  test('Selected Projects and includeArchivedProjects round-trip via GET /integrations/:id', async () => {
    const conn = makeConnection();
    const projectIds = ['ABC', 'DEF'];

    await request(app)
      .patch(`/api/v1/integrations/${conn.id}/project-scope`)
      .send({ projectScopeMode: 'selected', selectedProjectIds: projectIds, includeArchivedProjects: true });

    const getRes = await request(app).get(`/api/v1/integrations/${conn.id}`);

    expect(getRes.status).toBe(200);
    expect(getRes.body.projectScopeMode).toBe('selected');
    expect(getRes.body.selectedProjectIds).toEqual(projectIds);
    expect(getRes.body.includeArchivedProjects).toBe(true);
  });

  test('PATCH back to all mode clears selection requirement', async () => {
    const conn = makeConnection({ projectScopeMode: 'selected', selectedProjectIds: ['P1'] });

    const res = await request(app)
      .patch(`/api/v1/integrations/${conn.id}/project-scope`)
      .send({ projectScopeMode: 'all' });

    expect(res.status).toBe(200);
    expect(res.body.projectScopeMode).toBe('all');
  });

  test('returns 400 for invalid projectScopeMode value', async () => {
    const conn = makeConnection();
    const res = await request(app)
      .patch(`/api/v1/integrations/${conn.id}/project-scope`)
      .send({ projectScopeMode: 'everything' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PROJECT_SCOPE_MODE');
  });

  test('returns 404 for unknown connection', async () => {
    const res = await request(app)
      .patch(`/api/v1/integrations/unknown-id/project-scope`)
      .send({ projectScopeMode: 'all' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('CONNECTION_NOT_FOUND');
  });

  test('returns 409 for deleted connection', async () => {
    const conn = makeConnection({ status: 'soft_deleted', softDeletedAt: new Date().toISOString() });

    const res = await request(app)
      .patch(`/api/v1/integrations/${conn.id}/project-scope`)
      .send({ projectScopeMode: 'all' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CONNECTION_DELETED');
  });
});

// ============================================================
// 11. REAUTHENTICATION — POST /api/v1/integrations/:id/reauthenticate
// ============================================================
describe('Reauthentication — POST /api/v1/integrations/:id/reauthenticate', () => {
  test('returns authorization URL, state, and connectionId for an active connection', async () => {
    const conn = makeConnection();

    const res = await request(app)
      .post(`/api/v1/integrations/${conn.id}/reauthenticate`);

    expect(res.status).toBe(200);
    expect(res.body.authorizationUrl).toBeDefined();
    expect(res.body.state).toBeDefined();
    expect(res.body.expiresAt).toBeDefined();
    expect(res.body.connectionId).toBe(conn.id);

    // URL must point to Atlassian auth with all 21 scopes
    const url = new URL(res.body.authorizationUrl);
    expect(url.hostname).toBe('auth.atlassian.com');
    const scopesInUrl = url.searchParams.get('scope').split(' ');
    expect(scopesInUrl).toHaveLength(21);
    for (const scope of ALL_SCOPES) {
      expect(scopesInUrl).toContain(scope);
    }
  });

  test('pending state includes reauthConnectionId referencing the existing connection', async () => {
    const conn = makeConnection();

    const res = await request(app)
      .post(`/api/v1/integrations/${conn.id}/reauthenticate`);

    expect(res.status).toBe(200);
    const storedState = db.pendingStates.get(res.body.state);
    expect(storedState).toBeDefined();
    expect(storedState.reauthConnectionId).toBe(conn.id);
    expect(storedState.codeVerifier).toBeDefined();
  });

  test('returns 404 for unknown connection', async () => {
    const res = await request(app)
      .post('/api/v1/integrations/does-not-exist/reauthenticate');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('CONNECTION_NOT_FOUND');
  });

  test('returns 404 for hard-deleted connection', async () => {
    const conn = makeConnection({ status: 'hard_deleted' });
    const res = await request(app)
      .post(`/api/v1/integrations/${conn.id}/reauthenticate`);
    expect(res.status).toBe(404);
  });
});

// ============================================================
// 12. REAUTHENTICATION CALLBACK — updates existing connection in place
// ============================================================
describe('Reauthentication callback — updates existing connection in place', () => {
  function seedReauthState(stateId, connectionId, overrides = {}) {
    db.pendingStates.set(stateId, {
      state: stateId,
      codeVerifier: 'test-code-verifier',
      userId: 'user-callback',
      redirectUri: 'https://example.com/callback',
      path: 'express',
      reauthConnectionId: connectionId,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      ...overrides,
    });
  }

  test('callback with reauthConnectionId updates tokens + scopes on existing connection (UUID unchanged)', async () => {
    const conn = makeConnection({
      cloudId: 'cloud-abc',
      boardScopeDegraded: true,
      status: 'degraded',
    });
    const originalId = conn.id;

    seedReauthState('reauth-state-1', conn.id);

    // Seed a CloudSite so the update path runs
    const cloudSiteId = 'cs-' + conn.id;
    db.cloudSites.set(cloudSiteId, {
      id: cloudSiteId,
      cloudId: 'cloud-abc',
      connectionId: conn.id,
      availableScopes: [],
      resolvedAt: new Date().toISOString(),
      cacheExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // All 21 scopes now granted (including board write scope)
    axios.post.mockResolvedValue({
      data: {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        scope: ALL_SCOPES.join(' '),
      },
    });
    axios.get.mockResolvedValue({
      data: [
        { id: 'cloud-abc', name: 'Acme Jira', url: 'https://acme.atlassian.net', scopes: ALL_SCOPES },
      ],
    });

    const res = await request(app)
      .get('/api/v1/oauth/express/callback')
      .query({ code: 'reauth-code', state: 'reauth-state-1' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('status=success');
    expect(res.headers.location).toContain('reauth=true');
    expect(res.headers.location).toContain(originalId);

    // No new connection created — still exactly one connection (the original)
    expect(db.connections.size).toBe(1);
    const updated = db.connections.get(originalId);
    expect(updated).toBeDefined();
    expect(updated.id).toBe(originalId);

    // Tokens updated (encrypted, not plaintext)
    expect(updated.accessToken).not.toBe('new-access-token');
    expect(updated.accessToken.split('.')).toHaveLength(3);

    // Scopes refreshed — board scope no longer degraded
    expect(updated.boardScopeDegraded).toBe(false);
    expect(updated.status).toBe('active');
    expect(updated.grantedScopes).toEqual(expect.arrayContaining(ALL_SCOPES));
  });

  test('callback emits REAUTH lifecycle event with scope details', async () => {
    const conn = makeConnection({ cloudId: 'cloud-xyz' });
    seedReauthState('reauth-state-2', conn.id);

    axios.post.mockResolvedValue({
      data: {
        access_token: 'at2',
        refresh_token: 'rt2',
        expires_in: 3600,
        scope: ALL_SCOPES.join(' '),
      },
    });
    axios.get.mockResolvedValue({
      data: [{ id: 'cloud-xyz', name: 'XYZ Jira', url: 'https://xyz.atlassian.net', scopes: ALL_SCOPES }],
    });

    await request(app)
      .get('/api/v1/oauth/express/callback')
      .query({ code: 'reauth-code-2', state: 'reauth-state-2' })
      .redirects(0);

    const reauthEvents = [...db.lifecycleEvents.values()].filter(
      (e) => e.eventType === 'REAUTH' && e.connectionId === conn.id
    );
    expect(reauthEvents).toHaveLength(1);
    expect(reauthEvents[0].metadata.grantedScopes).toEqual(expect.arrayContaining(ALL_SCOPES));
  });

  test('callback redirects with CLOUD_ID_MISMATCH if the site is no longer accessible', async () => {
    const conn = makeConnection({ cloudId: 'cloud-original' });
    seedReauthState('reauth-state-3', conn.id);

    axios.post.mockResolvedValue({
      data: { access_token: 'at3', refresh_token: 'rt3', expires_in: 3600, scope: ALL_SCOPES.join(' ') },
    });
    // Different site returned — original cloudId gone
    axios.get.mockResolvedValue({
      data: [{ id: 'cloud-different', name: 'Different Site', url: 'https://different.atlassian.net', scopes: ALL_SCOPES }],
    });

    const res = await request(app)
      .get('/api/v1/oauth/express/callback')
      .query({ code: 'reauth-code-3', state: 'reauth-state-3' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('CLOUD_ID_MISMATCH');
    expect(res.headers.location).toContain('status=error');

    // Original connection unchanged
    const unchanged = db.connections.get(conn.id);
    expect(unchanged.cloudId).toBe('cloud-original');
  });

  test('callback with reauthConnectionId for missing connection redirects with CONNECTION_NOT_FOUND', async () => {
    const nonExistentId = 'does-not-exist';
    seedReauthState('reauth-state-4', nonExistentId);

    axios.post.mockResolvedValue({
      data: { access_token: 'at4', refresh_token: 'rt4', expires_in: 3600, scope: ALL_SCOPES.join(' ') },
    });
    axios.get.mockResolvedValue({
      data: [{ id: 'cloud-xyz', name: 'XYZ', url: 'https://xyz.atlassian.net', scopes: ALL_SCOPES }],
    });

    const res = await request(app)
      .get('/api/v1/oauth/express/callback')
      .query({ code: 'reauth-code-4', state: 'reauth-state-4' })
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('CONNECTION_NOT_FOUND');
    expect(res.headers.location).toContain('status=error');
  });
});
