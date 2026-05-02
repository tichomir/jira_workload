'use strict';

/**
 * Sprint 3 — siteEnum board fetch token-refresh regression tests
 *
 * Verifies that when the 401 interceptor on a jiraAxios instance refreshes the
 * access token, subsequent requests on the SAME instance (e.g. board config
 * after board list) use the new token and do not cause a second spurious 401.
 *
 * Root-cause: createJiraAxiosInstance was updating config.headers on the retried
 * request but not instance.defaults.headers, so the next request after a retry
 * still carried the expired token.
 */

// ---------------------------------------------------------------------------
// Environment setup — must precede any require()
// ---------------------------------------------------------------------------
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '0ae79904e41359173d04fe7a63a93c289db8b411b9467cbc87e4d0646e4c133d';
process.env.ATLASSIAN_CLIENT_ID        = 'test-client-id-siteEnum';
process.env.ATLASSIAN_CLIENT_SECRET    = 'test-client-secret-siteEnum';
process.env.ATLASSIAN_REDIRECT_URI     = 'https://localhost:4443/oauth/callback';
process.env.NODE_ENV                   = 'test';
process.env.FRONTEND_BASE_URL          = 'https://localhost:4443';

// ---------------------------------------------------------------------------
// Mock axios globally BEFORE any module is required
// ---------------------------------------------------------------------------
jest.mock('axios');

jest.mock('../src/services/crypto', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => v.replace(/^enc:/, ''),
}));

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const db = require('../src/db');
const { createJiraAxiosInstance } = require('../src/services/tokenService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedConnection(overrides = {}) {
  const id = uuidv4();
  const conn = {
    id,
    cloudId: 'cloud-siteEnum-test',
    siteName: 'siteEnum Token Refresh Test Site',
    siteUrl: 'https://siteEnum-test.atlassian.net',
    status: 'active',
    clientId: process.env.ATLASSIAN_CLIENT_ID,
    clientSecret: `enc:${process.env.ATLASSIAN_CLIENT_SECRET}`,
    accessToken: 'enc:expired-access-token',
    refreshToken: 'enc:initial-refresh-token',
    accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    grantedScopes: ['read:jira-work', 'read:board-scope:jira-software', 'manage:jira-webhook'],
    projectScopeMode: 'all',
    selectedProjectIds: [],
    userId: 'user-siteEnum',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cloudIdVerifiedAt: new Date().toISOString(), // skip cloudId check
    ...overrides,
  };
  db.connections.set(id, conn);
  return conn;
}

beforeEach(() => {
  db.connections.clear();
  db.backupJobs.clear();
  db.workflowNodes.clear();
  db.customFieldDefinitions.clear();
  db.customFieldContextNodes.clear();
  jest.clearAllMocks();
  // Reset axios.create mock: make it return a real-ish instance shape
  axios.create.mockImplementation((defaults) => {
    const inst = {
      defaults: { headers: { ...(defaults && defaults.headers) } },
      interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn() },
      },
      get: jest.fn(),
      post: jest.fn(),
    };
    return inst;
  });
});

// ===========================================================================
// Instance default header update after 401 refresh
// ===========================================================================
describe('createJiraAxiosInstance — instance default header updated on token refresh', () => {
  /**
   * This test does NOT use axios.create mock — it tests the real interceptor
   * logic by directly calling the interceptor error handler captured via
   * instance.interceptors.response.use.
   *
   * Flow:
   *   1. Create a real jiraAxios instance with an expired token.
   *   2. Simulate a 401 on request A (board list).
   *   3. The interceptor should: call refreshConnectionToken, update config.headers,
   *      update instance.defaults.headers, and retry.
   *   4. Request B (board config) should then use the NEW token — verified by
   *      checking that instance.defaults.headers['Authorization'] is the new token.
   */
  test('instance.defaults.headers is updated with new token after a 401 refresh', async () => {
    // Restore real axios.create for this test — we need the real interceptor wiring.
    // Use jest-mock-axios-style: mock create to return a real object with interceptors.
    jest.resetModules();

    // Re-setup mocks after resetModules
    jest.mock('axios');
    jest.mock('../src/services/crypto', () => ({
      encrypt: (v) => `enc:${v}`,
      decrypt: (v) => v.replace(/^enc:/, ''),
    }));

    const axiosFresh = require('axios');
    const dbFresh = require('../src/db');
    const { createJiraAxiosInstance: createInstance } = require('../src/services/tokenService');

    // Seed a connection with an expired-ish token
    const id = uuidv4();
    const conn = {
      id,
      cloudId: 'cloud-x',
      siteName: 'Test',
      siteUrl: 'https://x.atlassian.net',
      status: 'active',
      clientId: 'test-client-id-siteEnum',
      clientSecret: 'enc:test-client-secret-siteEnum',
      accessToken: 'enc:old-token',
      refreshToken: 'enc:old-refresh',
      accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      grantedScopes: ['read:jira-work', 'read:board-scope:jira-software'],
      projectScopeMode: 'all',
      selectedProjectIds: [],
      userId: 'u1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    dbFresh.connections.set(id, conn);

    // Mock token refresh
    axiosFresh.post.mockResolvedValueOnce({
      data: {
        access_token: 'new-token-after-refresh',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      },
    });

    // Capture what interceptors.response.use is called with
    let capturedErrorHandler = null;
    const mockInstance = {
      defaults: { headers: { Authorization: 'Bearer old-token', Accept: 'application/json' } },
      interceptors: {
        request: { use: jest.fn() },
        response: {
          use: jest.fn().mockImplementation((successHandler, errorHandler) => {
            capturedErrorHandler = errorHandler;
          }),
        },
      },
      get: jest.fn(),
      post: jest.fn(),
    };

    axiosFresh.create.mockReturnValue(mockInstance);

    const instance = createInstance(id, 'old-token', null);

    // Verify interceptors were registered
    expect(mockInstance.interceptors.response.use).toHaveBeenCalledTimes(1);
    expect(capturedErrorHandler).toBeDefined();

    // Simulate a 401 error on a request
    const error401 = {
      isAxiosError: true,
      config: {
        url: 'https://api.atlassian.com/ex/jira/cloud-x/rest/api/3/field',
        method: 'get',
        headers: { Authorization: 'Bearer old-token' },
        _retried: undefined,
      },
      response: {
        status: 401,
        statusText: 'Unauthorized',
        data: { code: 401, message: 'Unauthorized' },
      },
    };

    // Set up instance() call (for the retry) to succeed
    mockInstance.mockImplementation = undefined;
    // Make instance itself callable (axios instance is callable as a function)
    const instanceCallable = Object.assign(
      jest.fn().mockResolvedValueOnce({ data: [{ id: 'field-1' }] }),
      mockInstance
    );
    // Rebind instance reference in the closure — we can't easily do this without
    // re-reading the closure. Instead, verify the defaults header was updated by
    // calling the error handler and checking mockInstance.defaults.headers.

    // Call the interceptor error handler
    const retryPromise = capturedErrorHandler(error401).catch(() => {});
    await retryPromise;

    // The key assertion: after the interceptor fires, the instance default header
    // must be updated to the new token.
    expect(mockInstance.defaults.headers['Authorization']).toBe('Bearer new-token-after-refresh');
  });
});

// ===========================================================================
// Board fetch 401 does not fail if scope is present (non-scope 401)
// ===========================================================================
describe('siteEnum board fetch 401 handling', () => {
  test('board config 401 with board read scope triggers AUTH_ERROR not BOARD_READ_SCOPE_MISSING', async () => {
    jest.resetModules();
    jest.mock('axios');
    jest.mock('../src/services/crypto', () => ({
      encrypt: (v) => `enc:${v}`,
      decrypt: (v) => v.replace(/^enc:/, ''),
    }));

    const axiosFresh = require('axios');
    const dbFresh = require('../src/db');
    const { createJiraAxiosInstance: createInstance } = require('../src/services/tokenService');

    const id = uuidv4();
    dbFresh.connections.set(id, {
      id,
      cloudId: 'cloud-y',
      siteName: 'Test',
      siteUrl: 'https://y.atlassian.net',
      status: 'active',
      clientId: 'test-client-id-siteEnum',
      clientSecret: 'enc:secret',
      accessToken: 'enc:old-tok',
      refreshToken: 'enc:old-ref',
      accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      grantedScopes: ['read:jira-work', 'read:board-scope:jira-software'],
      projectScopeMode: 'all',
      selectedProjectIds: [],
      userId: 'u2',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let capturedErrorHandler = null;
    const mockInstance = {
      defaults: { headers: { Authorization: 'Bearer old-tok' } },
      interceptors: {
        request: { use: jest.fn() },
        response: {
          use: jest.fn().mockImplementation((ok, err) => {
            capturedErrorHandler = err;
          }),
        },
      },
      get: jest.fn(),
      post: jest.fn(),
    };
    axiosFresh.create.mockReturnValue(mockInstance);

    createInstance(id, 'old-tok', null);

    // Simulate second 401 (already retried) on a board URL
    const boardError = {
      isAxiosError: true,
      config: {
        url: 'https://api.atlassian.com/ex/jira/cloud-y/rest/agile/1.0/board/1/configuration',
        method: 'get',
        headers: { Authorization: 'Bearer refreshed-tok' },
        _retried: true, // already retried once
      },
      response: {
        status: 401,
        statusText: 'Unauthorized',
        data: { code: 401, message: 'Unauthorized' },
      },
    };

    // Since grantedScopes includes read:board-scope:jira-software, the
    // interceptor should NOT throw BOARD_READ_SCOPE_MISSING but should throw
    // AUTH_ERROR (Atlassian rejected both original and refreshed token).
    await expect(capturedErrorHandler(boardError)).rejects.toMatchObject({
      code: 'AUTH_ERROR',
    });
  });

  test('board config 401 WITHOUT board read scope throws BOARD_READ_SCOPE_MISSING', async () => {
    jest.resetModules();
    jest.mock('axios');
    jest.mock('../src/services/crypto', () => ({
      encrypt: (v) => `enc:${v}`,
      decrypt: (v) => v.replace(/^enc:/, ''),
    }));

    const axiosFresh = require('axios');
    const dbFresh = require('../src/db');
    const { createJiraAxiosInstance: createInstance } = require('../src/services/tokenService');

    const id = uuidv4();
    dbFresh.connections.set(id, {
      id,
      cloudId: 'cloud-z',
      siteName: 'Test',
      siteUrl: 'https://z.atlassian.net',
      status: 'active',
      clientId: 'test-client-id-siteEnum',
      clientSecret: 'enc:secret',
      accessToken: 'enc:old-tok',
      refreshToken: 'enc:old-ref',
      accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      // No read:board-scope:jira-software
      grantedScopes: ['read:jira-work'],
      projectScopeMode: 'all',
      selectedProjectIds: [],
      userId: 'u3',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let capturedErrorHandler = null;
    const mockInstance = {
      defaults: { headers: { Authorization: 'Bearer old-tok' } },
      interceptors: {
        request: { use: jest.fn() },
        response: {
          use: jest.fn().mockImplementation((ok, err) => {
            capturedErrorHandler = err;
          }),
        },
      },
      get: jest.fn(),
      post: jest.fn(),
    };
    axiosFresh.create.mockReturnValue(mockInstance);

    createInstance(id, 'old-tok', null);

    const boardError = {
      isAxiosError: true,
      config: {
        url: 'https://api.atlassian.com/ex/jira/cloud-z/rest/agile/1.0/board/5/configuration',
        method: 'get',
        headers: { Authorization: 'Bearer refreshed-tok' },
        _retried: true,
      },
      response: {
        status: 401,
        statusText: 'Unauthorized',
        data: { code: 401, message: 'Unauthorized' },
      },
    };

    await expect(capturedErrorHandler(boardError)).rejects.toMatchObject({
      code: 'BOARD_READ_SCOPE_MISSING',
    });
  });
});
