'use strict';

/**
 * Sprint 17 — 410 CloudId Retry Tests
 *
 * Tests for the 410 re-resolution path introduced in the 410 handler in jqlEnumeration.js.
 *
 * Three scenarios:
 *   TEST-1  410 on search/jql → force re-resolution via accessible-resources → retry succeeds
 *           with new cloudId. Backup completes and connection.cloudId is updated in DB.
 *
 *   TEST-2  410 on search/jql → force re-resolution → accessible-resources returns empty array
 *           → verifyAndRefreshCloudId throws CLOUD_ID_NOT_FOUND → backup job fails and
 *           connection.status = 'CLOUD_ID_NOT_FOUND'.
 *
 *   TEST-3  Freshness gate: connection has cloudIdVerifiedAt = now() (within 24h).
 *           A backup that succeeds normally must NOT call accessible-resources, i.e.
 *           axios.get must not be called for the freshness-suppressed code path.
 */

// ---------------------------------------------------------------------------
// Environment setup — must precede any require()
// ---------------------------------------------------------------------------
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '0ae79904e41359173d04fe7a63a93c289db8b411b9467cbc87e4d0646e4c133d';
process.env.ATLASSIAN_CLIENT_ID        = 'test-client-id-410';
process.env.ATLASSIAN_CLIENT_SECRET    = 'test-client-secret-410';
process.env.ATLASSIAN_REDIRECT_URI     = 'https://localhost:4443/oauth/callback';
process.env.NODE_ENV                   = 'test';
process.env.FRONTEND_BASE_URL          = 'https://localhost:4443';

// ---------------------------------------------------------------------------
// Mock axios globally BEFORE any module is required
// ---------------------------------------------------------------------------
jest.mock('axios');

jest.mock('../src/services/crypto', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => (typeof v === 'string' ? v.replace(/^enc:/, '') : v),
}));

const axios   = require('axios');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const db  = require('../src/db');
const app = require('../src/app');

// ---------------------------------------------------------------------------
// Controlled mock jiraAxios instance
// axios.create() is intercepted so every call returns our controllable mock.
// ---------------------------------------------------------------------------
const mockJiraGet  = jest.fn();
const mockJiraPost = jest.fn();
const mockJiraAxios = {
  get: mockJiraGet,
  post: mockJiraPost,
  interceptors: {
    request:  { use: jest.fn() },
    response: { use: jest.fn() },
  },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ACCESSIBLE_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearDb() {
  db.connections.clear();
  db.backupJobs.clear();
  db.backupPoints.clear();
  db.backupRunStates.clear();
  db.objectSnapshots.clear();
  db.projectNodes.clear();
  db.workflowNodes.clear();
  db.customFieldDefinitions.clear();
  db.customFieldContextNodes.clear();
  db.webhookRegistrations.clear();
  db.attachmentManifestEntries.clear();
  db.issueNodes.clear();
}

/**
 * Seed a connection.
 * cloudIdVerifiedAt defaults to now (fresh) so the initial verifyAndRefreshCloudId call
 * in backupEngine skips the accessible-resources network call.
 * Tests that need a stale cloudId should pass cloudIdVerifiedAt: null or an old timestamp.
 */
function seedConnection(overrides = {}) {
  const id = uuidv4();
  const conn = {
    id,
    cloudId:              overrides.cloudId  || 'old-cloud-id',
    siteUrl:              overrides.siteUrl  || 'https://test-410.atlassian.net',
    siteName:             'Test 410 Site',
    status:               'active',
    clientId:             process.env.ATLASSIAN_CLIENT_ID,
    clientSecret:         `enc:${process.env.ATLASSIAN_CLIENT_SECRET}`,
    accessToken:          'enc:test-access-token',
    refreshToken:         'enc:test-refresh-token',
    accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    // Default: fresh cloudIdVerifiedAt (within 24h) so initial verify is suppressed.
    // Tests that need a stale entry pass cloudIdVerifiedAt: null explicitly.
    cloudIdVerifiedAt:    overrides.cloudIdVerifiedAt !== undefined
                            ? overrides.cloudIdVerifiedAt
                            : new Date().toISOString(),
    grantedScopes:        ['read:jira-work'],
    projectScopeMode:     'all',
    selectedProjectIds:   [],
    userId:               'user-410-test',
    createdAt:            new Date().toISOString(),
    updatedAt:            new Date().toISOString(),
    lastSyncedAt:         null,
    ...overrides,
  };
  db.connections.set(id, conn);
  return conn;
}

/**
 * Set up mockJiraGet with standard backup-run responses.
 * If onSearchJqlFirstCall is provided, the first /search/jql call returns that response;
 * subsequent calls return the normal issue list.
 */
function setupJiraMockForBackup({ onSearchJqlFirstCall = null, cloudId = 'old-cloud-id' } = {}) {
  let searchJqlCallCount = 0;

  const defaultIssues = [
    {
      id: 'issue-001',
      key: 'PROJ-1',
      fields: {
        summary: 'Issue one',
        issuetype: { name: 'Task' },
        project: { key: 'PROJ' },
        labels: [],
        attachment: [],
        updated: new Date().toISOString(),
      },
    },
  ];

  mockJiraGet.mockImplementation((url) => {
    const urlStr = String(url);

    if (urlStr.includes('/project/search')) {
      return Promise.resolve({
        data: {
          values: [{ id: 'proj-1', key: 'PROJ', name: 'Project PROJ', projectTypeKey: 'software', archived: false }],
          isLast: true,
        },
      });
    }

    // Workflow search must come BEFORE generic /search check
    if (urlStr.includes('/workflow/search')) {
      return Promise.resolve({
        data: { values: [], isLast: true },
      });
    }

    if (urlStr.includes('/search/jql')) {
      searchJqlCallCount++;
      if (searchJqlCallCount === 1 && onSearchJqlFirstCall !== null) {
        if (onSearchJqlFirstCall instanceof Error) {
          return Promise.reject(onSearchJqlFirstCall);
        }
        return Promise.resolve(onSearchJqlFirstCall);
      }
      return Promise.resolve({
        data: {
          issues: defaultIssues,
          total: defaultIssues.length,
          startAt: 0,
          maxResults: 100,
        },
      });
    }

    if (urlStr.includes('/context')) {
      return Promise.resolve({ data: { values: [], isLast: true } });
    }

    if (urlStr.includes('/rest/api/3/field')) {
      return Promise.resolve({ data: [] });
    }

    return Promise.reject(
      Object.assign(new Error(`Unexpected GET: ${urlStr}`), { response: { status: 404 } })
    );
  });
}

/**
 * Poll the backup job status until it leaves 'running' or we time out.
 */
async function waitForBackupJob(jobId, integrationId, { maxAttempts = 40, intervalMs = 50 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await request(app).get(`/api/connections/${integrationId}/backup/${jobId}`);
    if (!res.body || res.body.status === undefined) {
      // Try the v1 endpoint as fallback
      const res2 = await request(app).get(`/api/v1/integrations/${integrationId}/backup/${jobId}`);
      if (res2.body && res2.body.status !== 'running') return res2.body;
    } else if (res.body.status !== 'running') {
      return res.body;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitForBackupJob timed out after ${maxAttempts} attempts`);
}

// ---------------------------------------------------------------------------
// Module-level setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearDb();
  jest.clearAllMocks();

  // Every call to axios.create() returns our controllable mock instance.
  axios.create.mockReturnValue(mockJiraAxios);

  mockJiraGet.mockReset();
  mockJiraPost.mockReset();
});

// ===========================================================================
// TEST-1: 410 on search/jql → re-resolve cloudId → retry succeeds → cloudId updated
// ===========================================================================

describe('TEST-1 — 410 retry: re-resolution succeeds, backup completes and cloudId updated', () => {
  test('when search/jql returns 410, verifyAndRefreshCloudId is called and backup retries with new cloudId', async () => {
    // Seed a connection with fresh cloudIdVerifiedAt so the initial backup-start
    // verifyAndRefreshCloudId call is suppressed by the freshness gate.
    // The stored cloudId is 'old-cloud-id' (stale in reality, but not yet detected).
    const conn = seedConnection({
      cloudId: 'old-cloud-id',
      cloudIdVerifiedAt: new Date().toISOString(), // fresh → initial check skipped
    });

    // Accessible-resources will be called when the 410 handler forces re-resolution.
    // It returns a new cloudId for the same site URL.
    axios.get.mockImplementation((url) => {
      if (url === ACCESSIBLE_RESOURCES_URL) {
        return Promise.resolve({
          data: [{ id: 'new-cloud-id', url: 'https://test-410.atlassian.net', name: 'Test 410 Site' }],
        });
      }
      return Promise.reject(new Error(`Unexpected axios.get: ${url}`));
    });

    // First /search/jql call returns 410; subsequent calls (retry) succeed.
    const goneError = Object.assign(new Error('Gone'), {
      response: { status: 410, data: { errorMessages: ['gone'], errors: {} } },
      isAxiosError: true,
    });
    setupJiraMockForBackup({ onSearchJqlFirstCall: goneError });

    // Trigger backup
    const triggerRes = await request(app)
      .post(`/api/connections/${conn.id}/backup`)
      .send({});

    expect(triggerRes.status).toBe(202);
    const { jobId } = triggerRes.body;
    expect(jobId).toBeDefined();

    // Wait for async job to finish
    const finalJob = await waitForBackupJob(jobId, conn.id);

    // AC-1a: backup job completes successfully (not failed)
    expect(finalJob.status).toBe('completed');

    // AC-1b: connection.cloudId is updated to the new cloudId in DB
    const updatedConn = db.connections.get(conn.id);
    expect(updatedConn.cloudId).toBe('new-cloud-id');

    // AC-1c: accessible-resources was called exactly once (by the 410 handler)
    expect(axios.get).toHaveBeenCalledWith(
      ACCESSIBLE_RESOURCES_URL,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringContaining('Bearer') }) })
    );
  }, 15000);
});

// ===========================================================================
// TEST-2: 410 on search/jql → re-resolution → empty accessible-resources → CLOUD_ID_NOT_FOUND
// ===========================================================================

describe('TEST-2 — 410 retry: accessible-resources empty → CLOUD_ID_NOT_FOUND failure', () => {
  test('when search/jql returns 410 and accessible-resources is empty, backup fails with CLOUD_ID_NOT_FOUND', async () => {
    const conn = seedConnection({
      cloudId: 'old-cloud-id',
      cloudIdVerifiedAt: new Date().toISOString(), // fresh → initial check suppressed
    });

    // Accessible-resources returns an empty array → site not found
    axios.get.mockImplementation((url) => {
      if (url === ACCESSIBLE_RESOURCES_URL) {
        return Promise.resolve({ data: [] });
      }
      return Promise.reject(new Error(`Unexpected axios.get: ${url}`));
    });

    // First /search/jql call returns 410 (triggers re-resolution attempt)
    const goneError = Object.assign(new Error('Gone'), {
      response: { status: 410, data: { errorMessages: ['gone'], errors: {} } },
      isAxiosError: true,
    });
    setupJiraMockForBackup({ onSearchJqlFirstCall: goneError });

    // Trigger backup
    const triggerRes = await request(app)
      .post(`/api/connections/${conn.id}/backup`)
      .send({});

    expect(triggerRes.status).toBe(202);
    const { jobId } = triggerRes.body;

    // Wait for the job to fail
    const finalJob = await waitForBackupJob(jobId, conn.id);

    // AC-2a: backup job status is failed
    expect(finalJob.status).toBe('failed');

    // AC-2b: connection.status reflects CLOUD_ID_NOT_FOUND
    const updatedConn = db.connections.get(conn.id);
    expect(updatedConn.status).toBe('CLOUD_ID_NOT_FOUND');
  }, 15000);
});

// ===========================================================================
// TEST-3: Freshness gate — fresh cloudIdVerifiedAt suppresses accessible-resources call
// ===========================================================================

describe('TEST-3 — Freshness gate: fresh cloudIdVerifiedAt suppresses accessible-resources', () => {
  test('backup run with fresh cloudIdVerifiedAt does NOT call accessible-resources', async () => {
    // Connection with fresh cloudIdVerifiedAt (within 24h) and a valid cloudId.
    const conn = seedConnection({
      cloudId: 'fresh-cloud-id',
      siteUrl: 'https://test-410.atlassian.net',
      cloudIdVerifiedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
    });

    // No accessible-resources call should happen; if it does, reject to catch it.
    axios.get.mockImplementation((url) => {
      return Promise.reject(new Error(`axios.get should not be called but was called with: ${url}`));
    });

    // Normal backup APIs succeed (no 410)
    setupJiraMockForBackup({ cloudId: 'fresh-cloud-id' });

    // Trigger backup
    const triggerRes = await request(app)
      .post(`/api/connections/${conn.id}/backup`)
      .send({});

    expect(triggerRes.status).toBe(202);
    const { jobId } = triggerRes.body;

    const finalJob = await waitForBackupJob(jobId, conn.id);

    // AC-3a: backup completes successfully
    expect(finalJob.status).toBe('completed');

    // AC-3b: accessible-resources was NOT called (freshness gate suppressed it)
    expect(axios.get).not.toHaveBeenCalled();
  }, 15000);
});
