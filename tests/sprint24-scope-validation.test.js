'use strict';

/**
 * Sprint 24 — Pre-restore Scope Validation
 *
 * TC-1: All required scopes present → GRANTED_SCOPES check passes
 * TC-2: write:board-scope:jira-software missing, basket has boards → BOARD_WRITE_SCOPE_MISSING
 * TC-3: write:jira-work missing, basket has issues → SCOPE_MISSING
 * TC-4: write:sprint:jira-software missing, basket has sprints → SCOPE_MISSING
 * TC-5: After reauth (scopes updated on connection), same restore basket passes scope check
 * TC-6: No connection in db → scope check passes (simulation/test context)
 * TC-7: runValidationPipeline returns blockingError with missing_scope / target_site / required_for_stage
 */

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '0ae79904e41359173d04fe7a63a93c289db8b411b9467cbc87e4d0646e4c133d';
process.env.ATLASSIAN_CLIENT_ID        = 'test-client-sprint24';
process.env.ATLASSIAN_CLIENT_SECRET    = 'test-secret-sprint24';
process.env.ATLASSIAN_REDIRECT_URI     = 'https://localhost:4443/oauth/callback';
process.env.NODE_ENV                   = 'test';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../src/services/tokenService', () => ({
  getValidAccessToken: jest.fn().mockResolvedValue('mock-access-token-sprint24'),
  createJiraAxiosInstance: jest.fn(),
  verifyAndRefreshCloudId: jest.fn().mockResolvedValue(undefined),
  refreshConnectionToken: jest.fn(),
}));

const { v4: uuidv4 } = require('uuid');

let db;
let checkGrantedScopes;
let runValidationPipeline;

beforeAll(() => {
  jest.resetModules();
  db = require('../src/db');
  ({ checkGrantedScopes, runValidationPipeline } = require('../src/services/validationService'));
});

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function clearDb() {
  db.connections.clear();
  db.backupPoints.clear();
  db.backupJobs.clear();
  db.restoreJobs.clear();
  db.objectSnapshots.clear();
}

beforeEach(clearDb);
afterEach(clearDb);

const TARGET_SITE = 'site-scope-test-001';

// Full scope set covering all restore stages
const ALL_SCOPES = [
  'read:jira-work',
  'read:jira-user',
  'read:board-scope:jira-software',
  'read:sprint:jira-software',
  'write:jira-work',
  'write:issue:jira',
  'write:project:jira',
  'manage:jira-project',
  'manage:jira-configuration',
  'write:field:jira',
  'write:board-scope:jira-software',
  'write:sprint:jira-software',
  'offline_access',
];

function seedConnection(overrides = {}) {
  const id = overrides.id || uuidv4();
  db.connections.set(id, {
    id,
    cloudId: TARGET_SITE,
    siteId: TARGET_SITE,
    status: 'active',
    accessToken: 'tok',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    cloudIdVerifiedAt: new Date().toISOString(),
    grantedScopes: ALL_SCOPES,
    deletedAt: null,
    ...overrides,
  });
  return id;
}

function makeBasketItem(objectType) {
  return { objectType, id: uuidv4() };
}

// ---------------------------------------------------------------------------
// TC-1: All required scopes present → passes
// ---------------------------------------------------------------------------

test('TC-1: all required scopes present — GRANTED_SCOPES check passes', () => {
  seedConnection();

  const basket = [
    makeBasketItem('issue'),
    makeBasketItem('board'),
    makeBasketItem('sprint'),
    makeBasketItem('project'),
    makeBasketItem('workflow'),
    makeBasketItem('customFieldDefinition'),
  ];

  const result = checkGrantedScopes(TARGET_SITE, basket, null);

  expect(result.passed).toBe(true);
});

// ---------------------------------------------------------------------------
// TC-2: write:board-scope:jira-software missing + boards in basket → BOARD_WRITE_SCOPE_MISSING
// ---------------------------------------------------------------------------

test('TC-2: write:board-scope missing with boards in basket → BOARD_WRITE_SCOPE_MISSING', () => {
  const scopesWithoutBoardWrite = ALL_SCOPES.filter(
    (s) => s !== 'write:board-scope:jira-software',
  );
  seedConnection({ grantedScopes: scopesWithoutBoardWrite });

  const basket = [makeBasketItem('issue'), makeBasketItem('board')];

  const result = checkGrantedScopes(TARGET_SITE, basket, null);

  expect(result.passed).toBe(false);
  expect(result.errorCode).toBe('BOARD_WRITE_SCOPE_MISSING');
  expect(result.missing_scope).toBe('write:board-scope:jira-software');
  expect(result.target_site).toBe(TARGET_SITE);
  expect(result.required_for_stage).toMatch(/board/i);
});

// ---------------------------------------------------------------------------
// TC-3: write:jira-work missing + issues in basket → SCOPE_MISSING
// ---------------------------------------------------------------------------

test('TC-3: write:jira-work missing with issues in basket → SCOPE_MISSING', () => {
  const scopesWithoutWriteWork = ALL_SCOPES.filter((s) => s !== 'write:jira-work');
  seedConnection({ grantedScopes: scopesWithoutWriteWork });

  const basket = [makeBasketItem('issue')];

  const result = checkGrantedScopes(TARGET_SITE, basket, null);

  expect(result.passed).toBe(false);
  expect(result.errorCode).toBe('SCOPE_MISSING');
  expect(result.missing_scope).toBe('write:jira-work');
  expect(result.target_site).toBe(TARGET_SITE);
  expect(result.required_for_stage).toMatch(/issue/i);
});

// ---------------------------------------------------------------------------
// TC-4: write:sprint:jira-software missing + sprints in basket → SCOPE_MISSING
// ---------------------------------------------------------------------------

test('TC-4: write:sprint:jira-software missing with sprints → SCOPE_MISSING', () => {
  const scopesWithoutSprint = ALL_SCOPES.filter(
    (s) => s !== 'write:sprint:jira-software',
  );
  seedConnection({ grantedScopes: scopesWithoutSprint });

  // Board scope is present, so the first sprint requirement (write:board-scope) passes.
  // The second sprint requirement (write:sprint:jira-software) should fail.
  const basket = [makeBasketItem('sprint')];

  const result = checkGrantedScopes(TARGET_SITE, basket, null);

  expect(result.passed).toBe(false);
  expect(result.errorCode).toBe('SCOPE_MISSING');
  expect(result.missing_scope).toBe('write:sprint:jira-software');
  expect(result.required_for_stage).toMatch(/sprint/i);
});

// ---------------------------------------------------------------------------
// TC-5: After reauth (scopes updated on connection), scope check passes
// ---------------------------------------------------------------------------

test('TC-5: after reauth — updated grantedScopes unblocks restore basket', () => {
  const connId = uuidv4();

  // Seed with write:board-scope missing
  seedConnection({
    id: connId,
    grantedScopes: ALL_SCOPES.filter((s) => s !== 'write:board-scope:jira-software'),
  });

  const basket = [makeBasketItem('board')];

  // Before reauth — should fail
  const before = checkGrantedScopes(TARGET_SITE, basket, connId);
  expect(before.passed).toBe(false);
  expect(before.errorCode).toBe('BOARD_WRITE_SCOPE_MISSING');

  // Simulate reauth: update grantedScopes on the existing connection record
  const conn = db.connections.get(connId);
  conn.grantedScopes = ALL_SCOPES;
  db.connections.set(connId, conn);

  // After reauth — same basket should pass
  const after = checkGrantedScopes(TARGET_SITE, basket, connId);
  expect(after.passed).toBe(true);
});

// ---------------------------------------------------------------------------
// TC-6: No connection in db → scope check passes (simulation/test context)
// ---------------------------------------------------------------------------

test('TC-6: no connections in db → scope check passes (simulation context)', () => {
  // db.connections is already cleared by beforeEach
  const basket = [makeBasketItem('board'), makeBasketItem('issue')];
  const result = checkGrantedScopes(TARGET_SITE, basket, null);
  expect(result.passed).toBe(true);
});

// ---------------------------------------------------------------------------
// TC-7: runValidationPipeline surfaces missing_scope / target_site / required_for_stage
// ---------------------------------------------------------------------------

test('TC-7: runValidationPipeline blockingError includes scope context fields', () => {
  seedConnection({
    grantedScopes: ALL_SCOPES.filter((s) => s !== 'write:board-scope:jira-software'),
  });

  const basket = [makeBasketItem('board')];
  const restoreRequest = {
    destination: { type: 'original' },
    connectionId: null,
  };

  const result = runValidationPipeline({
    restoreRequest,
    targetSiteId: TARGET_SITE,
    targetProjectKey: null,
    basketItems: basket,
    includeBoardSprintRestore: false,
  });

  expect(result.passed).toBe(false);
  expect(result.blockingError).toBeDefined();
  expect(result.blockingError.errorCode).toBe('BOARD_WRITE_SCOPE_MISSING');
  expect(result.blockingError.missing_scope).toBe('write:board-scope:jira-software');
  expect(result.blockingError.target_site).toBe(TARGET_SITE);
  expect(result.blockingError.required_for_stage).toBeDefined();
});
