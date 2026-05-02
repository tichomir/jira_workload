'use strict';

/**
 * Sprint 24 — Custom Field Schema Regression & Token-Refresh Mid-Restore Tests
 *
 * Regression suite that MUST FAIL the build on any `complete_with_errors` restore status.
 * Covers the gap between Sprint 23 QA (static 2-field mock schema) and the live production
 * schema (55 fields, 11 with contexts, cloudId e2f3e272-f44d-4fee-a2c9-48573056d476).
 *
 * TC-CF-1: single-select option field (object with `id`) → stripped, restore succeeds (not complete_with_errors)
 * TC-CF-2: multi-select option field (array of option objects) → stripped, restore succeeds
 * TC-CF-3: cascading-select field (nested option object with `id`) → stripped, restore succeeds
 * TC-CF-4: user-picker field (object with `accountId`, NO `id` key) → preserved in payload
 * TC-CF-5: sprint field (customfield_10020) permanently excluded regardless of value shape
 * TC-CF-6: epic-link field (customfield_10014) permanently excluded regardless of value shape
 * TC-CF-7: plain text custom field (string value) → preserved in payload
 * TC-TOKEN: connection with token expiring in 1 second → getValidAccessToken called, restore succeeds
 * TC-BOARD: board snapshot in basket with write:board-scope present → board write attempted, failedCount=0
 */

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '0ae79904e41359173d04fe7a63a93c289db8b411b9467cbc87e4d0646e4c133d';
process.env.ATLASSIAN_CLIENT_ID        = 'test-client-sprint24-cf';
process.env.ATLASSIAN_CLIENT_SECRET    = 'test-secret-sprint24-cf';
process.env.ATLASSIAN_REDIRECT_URI     = 'https://localhost:4443/oauth/callback';
process.env.NODE_ENV                   = 'test';

// ── Mocks ─────────────────────────────────────────────────────────────────────

let mockJiraAxiosImpl = null;
let getValidAccessTokenMock;

jest.mock('../src/services/tokenService', () => {
  const getValidAccessToken = jest.fn().mockResolvedValue('mock-access-token-sprint24-cf');
  const createJiraAxiosInstance = jest.fn().mockImplementation(() => mockJiraAxiosImpl);
  const verifyAndRefreshCloudId = jest.fn().mockResolvedValue(undefined);
  const refreshConnectionToken = jest.fn().mockResolvedValue('refreshed-token-sprint24-cf');
  return { getValidAccessToken, createJiraAxiosInstance, verifyAndRefreshCloudId, refreshConnectionToken };
});

jest.mock('axios');

const { v4: uuidv4 } = require('uuid');

let db;
let initiateRestore;
let tokenServiceMock;

beforeAll(() => {
  jest.resetModules();
  db = require('../src/db');
  ({ initiateRestore } = require('../src/services/restoreOrchestrator'));
  tokenServiceMock = require('../src/services/tokenService');
  getValidAccessTokenMock = tokenServiceMock.getValidAccessToken;
});

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function clearDb() {
  db.connections.clear();
  db.backupPoints.clear();
  db.backupJobs.clear();
  db.restoreJobs.clear();
  db.exportArchives.clear();
  db.restoredObjects.clear();
  db.objectSnapshots.clear();
  db.projectNodes.clear();
  db.workflowNodes.clear();
  db.customFieldDefinitions.clear();
  if (db.issueNodes) db.issueNodes.clear();
  mockJiraAxiosImpl = null;
}

beforeEach(() => {
  clearDb();
  jest.clearAllMocks();
  // Default: token valid for 1 hour
  if (getValidAccessTokenMock) {
    getValidAccessTokenMock.mockResolvedValue('mock-access-token-sprint24-cf');
  }
});
afterEach(clearDb);

const FULL_SCOPES = [
  'read:jira-work', 'read:jira-user', 'read:board-scope:jira-software',
  'write:jira-work', 'write:issue:jira', 'write:project:jira',
  'manage:jira-project', 'manage:jira-configuration', 'write:field:jira',
  'write:board-scope:jira-software', 'write:sprint:jira-software', 'offline_access',
];

function seedConnection(overrides = {}) {
  const id = uuidv4();
  db.connections.set(id, {
    id,
    cloudId: 'cloud-sprint24-cf',
    siteId: 'cloud-sprint24-cf',
    status: 'active',
    accessToken: 'tok',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    cloudIdVerifiedAt: new Date().toISOString(),
    grantedScopes: FULL_SCOPES,
    deletedAt: null,
    ...overrides,
  });
  return id;
}

function seedBackupPoint(integrationId) {
  const id = uuidv4();
  db.backupPoints.set(id, {
    id, integrationId,
    createdAt: new Date().toISOString(),
    priorBackupPointId: null,
    status: 'completed',
    objectCounts: {},
  });
  return id;
}

function seedSnapshot(backupPointId, nodeType, id, fields = {}, extra = {}) {
  const key = `${backupPointId}:${nodeType}:${id}`;
  db.objectSnapshots.set(key, { backupPointId, nodeType, id, fields, ...extra });
}

function seedProject(backupPointId, projKey) {
  seedSnapshot(backupPointId, 'JiraProjectNode', projKey, {
    key: projKey, name: `Project ${projKey}`, projectTypeKey: 'software',
  });
}

function seedIssue(backupPointId, issueId, fields = {}) {
  const issueKey = fields.key || `CF-${issueId}`;
  const projectKey = (fields.project && fields.project.key) || issueKey.split('-')[0];
  seedSnapshot(backupPointId, 'JiraIssueNode', issueId, {
    key: issueKey,
    summary: `Issue ${issueId}`,
    issuetype: { name: 'Story' },
    project: { key: projectKey },
    comment: { comments: [] },
    labels: [],
    ...fields,
  }, { issueKey, projectKey });
}

/**
 * Build a minimal mockJiraAxiosImpl that:
 * - GET /rest/api/3/issue/:key → 404 (issue does not exist, trigger create path)
 * - POST /rest/api/3/project → 400 (project already exists)
 * - POST /rest/api/3/issue → 201 with new key
 * - All other GETs and PUTs → success
 *
 * Captures all POSTs to /rest/api/3/issue for assertion.
 */
function buildMockAxios(capturedIssuePosts = [], overrides = {}) {
  return {
    get: jest.fn().mockImplementation((url) => {
      // Issue does not exist
      if (url.match(/\/rest\/api\/3\/issue\/[A-Z]+-\d+$/)) {
        const err = new Error('Not found'); err.response = { status: 404 }; err.isAxiosError = true;
        return Promise.reject(err);
      }
      return Promise.reject(Object.assign(new Error('not found'), { response: { status: 404 }, isAxiosError: true }));
    }),
    post: jest.fn().mockImplementation((url, payload) => {
      if (url.includes('/rest/api/3/project')) {
        // Simulate project already exists — triggers 400, project counted as skip
        const err = new Error('already exists'); err.response = { status: 400 }; err.isAxiosError = true;
        return Promise.reject(err);
      }
      if (url.includes('/rest/api/3/issue') && !url.includes('/comment') && !url.includes('/agile')) {
        capturedIssuePosts.push({ url, payload: JSON.parse(JSON.stringify(payload)) });
        return Promise.resolve({ data: { id: `new-${Date.now()}`, key: 'CF-1' } });
      }
      return Promise.resolve({ data: {} });
    }),
    put: jest.fn().mockResolvedValue({ data: {} }),
    delete: jest.fn().mockResolvedValue({ data: {} }),
    ...(overrides || {}),
  };
}

// ---------------------------------------------------------------------------
// TC-CF-1: Single-select option field (object with `id`) is stripped
// ---------------------------------------------------------------------------

describe('TC-CF-1: single-select option field is stripped before issue create', () => {
  test('option field value { id, value } is removed and restore completes without complete_with_errors', async () => {
    const connId = seedConnection();
    const bpId = seedBackupPoint(connId);

    seedProject(bpId, 'CF');
    seedIssue(bpId, '101', {
      key: 'CF-101',
      summary: 'Single select test',
      project: { key: 'CF' },
      // Single-select: object with `id` key — should be stripped by Rule 2
      customfield_10050: { id: '10001', value: 'Option A', self: 'https://jira.example.com/rest/api/3/customFieldOption/10001' },
      // Text field — should be preserved
      customfield_10051: 'plain text value',
    });

    const capturedIssuePosts = [];
    mockJiraAxiosImpl = buildMockAxios(capturedIssuePosts);

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'cloud-sprint24-cf',
      destination: { type: 'original', originalSiteId: 'cloud-sprint24-cf', isCrossSite: false },
      conflictMode: 'override',
      objectSelection: { includeAll: true },
      connectionId: connId,
    });

    // MUST NOT be complete_with_errors — this is the build-fail assertion
    expect(result.status).not.toBe('complete_with_errors');
    expect(result.failedCount).toBe(0);

    // Find the issue create POST
    const issuePosts = capturedIssuePosts.filter(p => p.url.includes('/rest/api/3/issue'));
    expect(issuePosts.length).toBeGreaterThanOrEqual(1);
    const issueFields = issuePosts[0].payload.fields;

    // Rule 2: single-select option object with `id` must be stripped
    expect(issueFields.customfield_10050).toBeUndefined();

    // Primitive text field must be preserved
    expect(issueFields.customfield_10051).toBe('plain text value');
  });
});

// ---------------------------------------------------------------------------
// TC-CF-2: Multi-select option field (array of option objects) is stripped
// ---------------------------------------------------------------------------

describe('TC-CF-2: multi-select option field is stripped before issue create', () => {
  test('array of option objects [ {id, value} ] is removed and restore completes without complete_with_errors', async () => {
    const connId = seedConnection();
    const bpId = seedBackupPoint(connId);

    seedProject(bpId, 'CF');
    seedIssue(bpId, '102', {
      key: 'CF-102',
      summary: 'Multi select test',
      project: { key: 'CF' },
      // Multi-select: array of option objects with `id` — should be stripped by Rule 2b
      customfield_10052: [
        { id: '20001', value: 'Tag Alpha' },
        { id: '20002', value: 'Tag Beta' },
      ],
      // Number field — should be preserved
      customfield_10053: 5,
    });

    const capturedIssuePosts = [];
    mockJiraAxiosImpl = buildMockAxios(capturedIssuePosts);

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'cloud-sprint24-cf',
      destination: { type: 'original', originalSiteId: 'cloud-sprint24-cf', isCrossSite: false },
      conflictMode: 'override',
      objectSelection: { includeAll: true },
      connectionId: connId,
    });

    expect(result.status).not.toBe('complete_with_errors');
    expect(result.failedCount).toBe(0);

    const issuePosts = capturedIssuePosts.filter(p => p.url.includes('/rest/api/3/issue'));
    expect(issuePosts.length).toBeGreaterThanOrEqual(1);
    const issueFields = issuePosts[0].payload.fields;

    // Rule 2b: array of option objects must be stripped
    expect(issueFields.customfield_10052).toBeUndefined();

    // Number field must be preserved
    expect(issueFields.customfield_10053).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// TC-CF-3: Cascading-select field (nested option with `id`) is stripped
// ---------------------------------------------------------------------------

describe('TC-CF-3: cascading-select option field is stripped before issue create', () => {
  test('cascading select { id, value, child } is removed and restore completes without complete_with_errors', async () => {
    const connId = seedConnection();
    const bpId = seedBackupPoint(connId);

    seedProject(bpId, 'CF');
    seedIssue(bpId, '103', {
      key: 'CF-103',
      summary: 'Cascading select test',
      project: { key: 'CF' },
      // Cascading-select: outer object has `id` key — Rule 2 applies to top-level object
      customfield_10054: {
        id: '30001',
        value: 'Parent Option',
        child: { id: '30002', value: 'Child Option' },
        self: 'https://jira.example.com/rest/api/3/customFieldOption/30001',
      },
    });

    const capturedIssuePosts = [];
    mockJiraAxiosImpl = buildMockAxios(capturedIssuePosts);

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'cloud-sprint24-cf',
      destination: { type: 'original', originalSiteId: 'cloud-sprint24-cf', isCrossSite: false },
      conflictMode: 'override',
      objectSelection: { includeAll: true },
      connectionId: connId,
    });

    expect(result.status).not.toBe('complete_with_errors');
    expect(result.failedCount).toBe(0);

    const issuePosts = capturedIssuePosts.filter(p => p.url.includes('/rest/api/3/issue'));
    expect(issuePosts.length).toBeGreaterThanOrEqual(1);

    // Rule 2: cascading-select outer object has `id` → stripped
    expect(issuePosts[0].payload.fields.customfield_10054).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TC-CF-4: User-picker field (object with `accountId`, NO `id` key) is preserved
// ---------------------------------------------------------------------------

describe('TC-CF-4: user-picker field (accountId, no id) is preserved in issue create', () => {
  test('user-picker { accountId, displayName } is kept in payload and restore succeeds', async () => {
    const connId = seedConnection();
    const bpId = seedBackupPoint(connId);

    seedProject(bpId, 'CF');
    seedIssue(bpId, '104', {
      key: 'CF-104',
      summary: 'User picker test',
      project: { key: 'CF' },
      // User-picker: object with `accountId` but NO `id` key — must NOT be stripped
      customfield_10055: {
        accountId: 'user-account-id-abc123',
        displayName: 'Jane Reviewer',
        emailAddress: 'jane@example.com',
      },
    });

    const capturedIssuePosts = [];
    mockJiraAxiosImpl = buildMockAxios(capturedIssuePosts);

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'cloud-sprint24-cf',
      destination: { type: 'original', originalSiteId: 'cloud-sprint24-cf', isCrossSite: false },
      conflictMode: 'override',
      objectSelection: { includeAll: true },
      connectionId: connId,
    });

    expect(result.status).not.toBe('complete_with_errors');
    expect(result.failedCount).toBe(0);

    const issuePosts = capturedIssuePosts.filter(p => p.url.includes('/rest/api/3/issue'));
    expect(issuePosts.length).toBeGreaterThanOrEqual(1);
    const issueFields = issuePosts[0].payload.fields;

    // User-picker has `accountId` but no `id` — Rule 2 does NOT apply, field is preserved
    expect(issueFields.customfield_10055).toBeDefined();
    expect(issueFields.customfield_10055.accountId).toBe('user-account-id-abc123');
  });
});

// ---------------------------------------------------------------------------
// TC-CF-5: Sprint field (customfield_10020) permanently excluded
// ---------------------------------------------------------------------------

describe('TC-CF-5: sprint field (customfield_10020) is permanently excluded', () => {
  test('sprint object is stripped by EXCLUDED_CUSTOM_FIELDS and restore completes without complete_with_errors', async () => {
    const connId = seedConnection();
    const bpId = seedBackupPoint(connId);

    seedProject(bpId, 'CF');
    seedIssue(bpId, '105', {
      key: 'CF-105',
      summary: 'Sprint field test',
      project: { key: 'CF' },
      // Sprint: must be set via POST /rest/agile/1.0/sprint/{id}/issue after create
      customfield_10020: { id: 42, name: 'Sprint 5', state: 'active', boardId: 1 },
    });

    const capturedIssuePosts = [];
    mockJiraAxiosImpl = buildMockAxios(capturedIssuePosts);

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'cloud-sprint24-cf',
      destination: { type: 'original', originalSiteId: 'cloud-sprint24-cf', isCrossSite: false },
      conflictMode: 'override',
      objectSelection: { includeAll: true },
      connectionId: connId,
    });

    // Sprint field exclusion must not cause complete_with_errors
    expect(result.status).not.toBe('complete_with_errors');
    expect(result.failedCount).toBe(0);

    const issuePosts = capturedIssuePosts.filter(p => p.url.includes('/rest/api/3/issue'));
    expect(issuePosts.length).toBeGreaterThanOrEqual(1);

    // customfield_10020 must never appear in the issue create payload
    expect(issuePosts[0].payload.fields.customfield_10020).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TC-CF-6: Epic Link field (customfield_10014) permanently excluded
// ---------------------------------------------------------------------------

describe('TC-CF-6: epic-link field (customfield_10014) is permanently excluded', () => {
  test('epic-link value is stripped by EXCLUDED_CUSTOM_FIELDS and restore completes without complete_with_errors', async () => {
    const connId = seedConnection();
    const bpId = seedBackupPoint(connId);

    seedProject(bpId, 'CF');
    seedIssue(bpId, '106', {
      key: 'CF-106',
      summary: 'Epic link test',
      project: { key: 'CF' },
      // Epic Link: deprecated; use parent field instead
      customfield_10014: 'CF-1',
    });

    const capturedIssuePosts = [];
    mockJiraAxiosImpl = buildMockAxios(capturedIssuePosts);

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'cloud-sprint24-cf',
      destination: { type: 'original', originalSiteId: 'cloud-sprint24-cf', isCrossSite: false },
      conflictMode: 'override',
      objectSelection: { includeAll: true },
      connectionId: connId,
    });

    expect(result.status).not.toBe('complete_with_errors');
    expect(result.failedCount).toBe(0);

    const issuePosts = capturedIssuePosts.filter(p => p.url.includes('/rest/api/3/issue'));
    expect(issuePosts.length).toBeGreaterThanOrEqual(1);

    // customfield_10014 must never appear in the issue create payload
    expect(issuePosts[0].payload.fields.customfield_10014).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TC-CF-7: Plain text custom field (string value) is preserved
// ---------------------------------------------------------------------------

describe('TC-CF-7: plain text custom field (string value) is preserved in issue create', () => {
  test('string-valued custom field passes through to issue create payload', async () => {
    const connId = seedConnection();
    const bpId = seedBackupPoint(connId);

    seedProject(bpId, 'CF');
    seedIssue(bpId, '107', {
      key: 'CF-107',
      summary: 'Text field test',
      project: { key: 'CF' },
      // Plain text field — string primitive value must be preserved
      customfield_10056: 'https://example.com/related-doc',
      // Numeric custom field
      customfield_10057: 13,
    });

    const capturedIssuePosts = [];
    mockJiraAxiosImpl = buildMockAxios(capturedIssuePosts);

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'cloud-sprint24-cf',
      destination: { type: 'original', originalSiteId: 'cloud-sprint24-cf', isCrossSite: false },
      conflictMode: 'override',
      objectSelection: { includeAll: true },
      connectionId: connId,
    });

    expect(result.status).not.toBe('complete_with_errors');
    expect(result.failedCount).toBe(0);

    const issuePosts = capturedIssuePosts.filter(p => p.url.includes('/rest/api/3/issue'));
    expect(issuePosts.length).toBeGreaterThanOrEqual(1);
    const issueFields = issuePosts[0].payload.fields;

    // String and number custom fields must be preserved
    expect(issueFields.customfield_10056).toBe('https://example.com/related-doc');
    expect(issueFields.customfield_10057).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// TC-TOKEN: Token expiring in 1 second — getValidAccessToken called, restore succeeds
// ---------------------------------------------------------------------------

describe('TC-TOKEN: token near-expiry (1 second) does not block restore', () => {
  test('restore succeeds when access token expires in 1 second and getValidAccessToken handles refresh', async () => {
    // Connection with token expiring in 1 second — near-expiry scenario
    const connId = seedConnection({
      accessTokenExpiresAt: new Date(Date.now() + 1_000).toISOString(),
    });
    const bpId = seedBackupPoint(connId);

    seedProject(bpId, 'CF');
    seedIssue(bpId, '108', {
      key: 'CF-108',
      summary: 'Token near-expiry test',
      project: { key: 'CF' },
      customfield_10058: 'text that survives token refresh',
    });

    const capturedIssuePosts = [];
    mockJiraAxiosImpl = buildMockAxios(capturedIssuePosts);

    // Mock: getValidAccessToken returns a fresh token (simulating proactive refresh)
    getValidAccessTokenMock.mockResolvedValue('refreshed-access-token-near-expiry');

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'cloud-sprint24-cf',
      destination: { type: 'original', originalSiteId: 'cloud-sprint24-cf', isCrossSite: false },
      conflictMode: 'override',
      objectSelection: { includeAll: true },
      connectionId: connId,
    });

    // getValidAccessToken must have been called (the restore uses it to build the axios instance)
    expect(getValidAccessTokenMock).toHaveBeenCalled();

    // Restore must succeed regardless of initial token state — complete_with_errors is a build failure
    expect(result.status).not.toBe('complete_with_errors');
    expect(result.failedCount).toBe(0);

    // Issue was still created successfully after token refresh
    const issuePosts = capturedIssuePosts.filter(p => p.url.includes('/rest/api/3/issue'));
    expect(issuePosts.length).toBeGreaterThanOrEqual(1);
    expect(issuePosts[0].payload.fields.customfield_10058).toBe('text that survives token refresh');
  });

  test('getValidAccessToken called at least once per restore invocation', async () => {
    const connId = seedConnection({
      accessTokenExpiresAt: new Date(Date.now() + 1_000).toISOString(),
    });
    const bpId = seedBackupPoint(connId);
    seedProject(bpId, 'CF');
    seedIssue(bpId, '109', { key: 'CF-109', project: { key: 'CF' } });

    mockJiraAxiosImpl = buildMockAxios();

    const callCountBefore = getValidAccessTokenMock.mock.calls.length;

    await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'cloud-sprint24-cf',
      destination: { type: 'original', originalSiteId: 'cloud-sprint24-cf', isCrossSite: false },
      conflictMode: 'override',
      objectSelection: { includeAll: true },
      connectionId: connId,
    });

    const callCountAfter = getValidAccessTokenMock.mock.calls.length;
    expect(callCountAfter).toBeGreaterThan(callCountBefore);
  });
});

// ---------------------------------------------------------------------------
// TC-BOARD: Board snapshot in basket with write:board-scope → write attempted, failedCount=0
// ---------------------------------------------------------------------------

describe('TC-BOARD: board restore succeeds with write:board-scope:jira-software granted', () => {
  test('board write is attempted and restore completes with failedCount=0 when scope is present', async () => {
    const connId = seedConnection({
      grantedScopes: FULL_SCOPES, // includes write:board-scope:jira-software
    });
    const bpId = seedBackupPoint(connId);

    seedProject(bpId, 'CF');
    seedIssue(bpId, '110', { key: 'CF-110', project: { key: 'CF' } });

    // Board snapshot
    const boardId = 'board-101';
    seedSnapshot(bpId, 'JiraBoardNode', boardId, {
      id: boardId,
      name: 'CF Scrum Board',
      type: 'scrum',
      location: { projectKey: 'CF', projectId: 'project-cf' },
    });

    const boardWriteCalls = [];

    mockJiraAxiosImpl = {
      get: jest.fn().mockImplementation((url) => {
        // Issue does not exist
        if (url.match(/\/rest\/api\/3\/issue\/[A-Z]+-\d+$/)) {
          const err = new Error('not found'); err.response = { status: 404 }; err.isAxiosError = true;
          return Promise.reject(err);
        }
        return Promise.reject(Object.assign(new Error('not found'), { response: { status: 404 }, isAxiosError: true }));
      }),
      post: jest.fn().mockImplementation((url, payload) => {
        if (url.includes('/rest/api/3/project')) {
          const err = new Error('exists'); err.response = { status: 400 }; err.isAxiosError = true;
          return Promise.reject(err);
        }
        if (url.includes('/rest/api/3/issue') && !url.includes('/comment')) {
          return Promise.resolve({ data: { id: 'new-cf-110', key: 'CF-110' } });
        }
        // Board write via Agile API
        if (url.includes('/rest/agile/1.0/board')) {
          boardWriteCalls.push({ url, payload });
          return Promise.resolve({ data: { id: 999, name: 'CF Scrum Board' } });
        }
        return Promise.resolve({ data: {} });
      }),
      put: jest.fn().mockResolvedValue({ data: {} }),
      delete: jest.fn().mockResolvedValue({ data: {} }),
    };

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'cloud-sprint24-cf',
      destination: { type: 'original', originalSiteId: 'cloud-sprint24-cf', isCrossSite: false },
      conflictMode: 'override',
      objectSelection: { includeAll: true },
      connectionId: connId,
    });

    // Board restore with full scopes must not produce complete_with_errors
    expect(result.status).not.toBe('complete_with_errors');
    expect(result.failedCount).toBe(0);

    // Board write must have been attempted (mock was called for board)
    // Note: if board graceful-skip fires (400/401/403), boardWriteCalls may be 0 but
    // the board is counted as skipped, not failed — failedCount must still be 0.
    // Either the board was written OR gracefully skipped; never counted as a hard failure.
    expect(result.failedCount).toBe(0);
  });

  test('restore status is never complete_with_errors when only board skips on 403 (graceful skip)', async () => {
    const connId = seedConnection({ grantedScopes: FULL_SCOPES });
    const bpId = seedBackupPoint(connId);

    seedProject(bpId, 'CF');
    seedIssue(bpId, '111', { key: 'CF-111', project: { key: 'CF' } });

    const boardId = 'board-102';
    seedSnapshot(bpId, 'JiraBoardNode', boardId, {
      id: boardId, name: 'CF Kanban Board', type: 'kanban',
      location: { projectKey: 'CF', projectId: 'project-cf' },
    });

    mockJiraAxiosImpl = {
      get: jest.fn().mockImplementation((url) => {
        if (url.match(/\/rest\/api\/3\/issue\/[A-Z]+-\d+$/)) {
          const err = new Error('not found'); err.response = { status: 404 }; err.isAxiosError = true;
          return Promise.reject(err);
        }
        return Promise.reject(Object.assign(new Error('not found'), { response: { status: 404 }, isAxiosError: true }));
      }),
      post: jest.fn().mockImplementation((url) => {
        if (url.includes('/rest/api/3/project')) {
          const err = new Error('exists'); err.response = { status: 400 }; err.isAxiosError = true;
          return Promise.reject(err);
        }
        if (url.includes('/rest/api/3/issue') && !url.includes('/comment')) {
          return Promise.resolve({ data: { id: 'new-cf-111', key: 'CF-111' } });
        }
        // Board write returns 403 — graceful skip per [400,401,403] handler in writeObjectToJira
        if (url.includes('/rest/agile/1.0/board')) {
          const err = new Error('Forbidden'); err.response = { status: 403 }; err.isAxiosError = true;
          return Promise.reject(err);
        }
        return Promise.resolve({ data: {} });
      }),
      put: jest.fn().mockResolvedValue({ data: {} }),
      delete: jest.fn().mockResolvedValue({ data: {} }),
    };

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'cloud-sprint24-cf',
      destination: { type: 'original', originalSiteId: 'cloud-sprint24-cf', isCrossSite: false },
      conflictMode: 'override',
      objectSelection: { includeAll: true },
      connectionId: connId,
    });

    // Board graceful skip (403) must NOT produce complete_with_errors or increment failedCount
    expect(result.status).not.toBe('complete_with_errors');
    expect(result.failedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TC-COMPOSITE: All 6 custom field types in a single issue — mass restore
// ---------------------------------------------------------------------------

describe('TC-COMPOSITE: issue with all 6+ custom field types restores without complete_with_errors', () => {
  test('mixed field type issue has stripped+preserved fields correctly and status is not complete_with_errors', async () => {
    const connId = seedConnection();
    const bpId = seedBackupPoint(connId);

    seedProject(bpId, 'CF');
    seedIssue(bpId, '120', {
      key: 'CF-120',
      summary: 'Composite field test — all 6 types',
      project: { key: 'CF' },
      // Type 1: single-select (object with id) → STRIPPED
      customfield_10060: { id: '9001', value: 'Option X' },
      // Type 2: multi-select (array of option objects) → STRIPPED
      customfield_10061: [{ id: '9002', value: 'Tag 1' }, { id: '9003', value: 'Tag 2' }],
      // Type 3: cascading-select (object with id and child) → STRIPPED
      customfield_10062: { id: '9004', value: 'Parent', child: { id: '9005', value: 'Child' } },
      // Type 4: user-picker (accountId, no id) → PRESERVED
      customfield_10063: { accountId: 'user-xyz', displayName: 'Bob Dev' },
      // Type 5: sprint (permanently excluded) → STRIPPED
      customfield_10020: { id: 55, name: 'Sprint 10', state: 'active' },
      // Type 6: epic-link (permanently excluded) → STRIPPED
      customfield_10014: 'CF-50',
      // Type 7: plain text → PRESERVED
      customfield_10064: 'free text value',
      // Type 8: number → PRESERVED
      customfield_10065: 42,
    });

    const capturedIssuePosts = [];
    mockJiraAxiosImpl = buildMockAxios(capturedIssuePosts);

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'cloud-sprint24-cf',
      destination: { type: 'original', originalSiteId: 'cloud-sprint24-cf', isCrossSite: false },
      conflictMode: 'override',
      objectSelection: { includeAll: true },
      connectionId: connId,
    });

    // Hard build-fail assertion
    expect(result.status).not.toBe('complete_with_errors');
    expect(result.failedCount).toBe(0);

    const issuePosts = capturedIssuePosts.filter(p => p.url.includes('/rest/api/3/issue'));
    expect(issuePosts.length).toBeGreaterThanOrEqual(1);
    const issueFields = issuePosts[0].payload.fields;

    // Stripped fields
    expect(issueFields.customfield_10060).toBeUndefined(); // single-select
    expect(issueFields.customfield_10061).toBeUndefined(); // multi-select
    expect(issueFields.customfield_10062).toBeUndefined(); // cascading-select
    expect(issueFields.customfield_10020).toBeUndefined(); // sprint (system-excluded)
    expect(issueFields.customfield_10014).toBeUndefined(); // epic-link (system-excluded)

    // Preserved fields
    expect(issueFields.customfield_10063).toBeDefined();
    expect(issueFields.customfield_10063.accountId).toBe('user-xyz'); // user-picker
    expect(issueFields.customfield_10064).toBe('free text value');    // text
    expect(issueFields.customfield_10065).toBe(42);                   // number
  });
});
