'use strict';

/**
 * Sprint 3 — Project Enumeration Pagination Test
 *
 * Verifies that the GET /rest/api/3/project/search pagination loop in
 * backupEngine.runIntegrationBackup() correctly handles the isLast flag
 * and accumulates ALL pages before building objectSnapshots.
 *
 * Acceptance criteria:
 *   TC-PAG-1  When the API returns multiple pages (isLast=false then isLast=true),
 *             ALL projects from ALL pages are captured in db.projectNodes.
 *   TC-PAG-2  The backup point objectCounts.projects equals the total project count
 *             across all pages, not just the first page.
 *   TC-PAG-3  startAt advances correctly page-by-page (no double-fetching,
 *             no skipped pages).
 *   TC-PAG-4  When the API errors out, the engine falls back to cached projectNodes
 *             without aborting the backup.
 *   TC-PAG-5  A single-page response (isLast=true on first page) works correctly.
 *
 * Root cause this guards against: if the loop exited after the first page
 * (ignoring isLast=false) or did not await each page, projects from later
 * pages would be silently missing from the backup basket.
 */

// ---------------------------------------------------------------------------
// Environment setup — must precede any require()
// ---------------------------------------------------------------------------
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '0ae79904e41359173d04fe7a63a93c289db8b411b9467cbc87e4d0646e4c133d';
process.env.ATLASSIAN_CLIENT_ID        = 'test-client-id-pagination';
process.env.ATLASSIAN_CLIENT_SECRET    = 'test-secret-pagination';
process.env.ATLASSIAN_REDIRECT_URI     = 'https://localhost:4443/oauth/callback';
process.env.NODE_ENV                   = 'test';
process.env.FRONTEND_BASE_URL          = 'https://localhost:4443';

// ---------------------------------------------------------------------------
// Mock axios BEFORE any module requires it
// ---------------------------------------------------------------------------
jest.mock('axios');

jest.mock('../src/services/crypto', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => v.replace(/^enc:/, ''),
}));

jest.mock('../src/services/tokenService', () => {
  const axiosMod = require('axios');
  return {
    getValidAccessToken: jest.fn().mockResolvedValue('mock-access-token-pagination'),
    createJiraAxiosInstance: jest.fn(() => ({
      get:  axiosMod.get,
      post: axiosMod.post,
    })),
    refreshConnectionToken: jest.fn().mockResolvedValue('mock-access-token-pagination'),
  };
});

const request = require('supertest');
const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = require('../src/app');
const db  = require('../src/db');

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

// Page 1 of project/search: 3 projects, isLast = false
const PAGE_1_PROJECTS = [
  { id: '10001', key: 'ALPHA', name: 'Alpha Project', projectTypeKey: 'software', archived: false },
  { id: '10002', key: 'BETA',  name: 'Beta Project',  projectTypeKey: 'software', archived: false },
  { id: '10003', key: 'GAMMA', name: 'Gamma Project', projectTypeKey: 'business', archived: false },
];

// Page 2 of project/search: 2 projects, isLast = true
const PAGE_2_PROJECTS = [
  { id: '10004', key: 'DELTA',   name: 'Delta Project',   projectTypeKey: 'software', archived: false },
  { id: '10005', key: 'EPSILON', name: 'Epsilon Project', projectTypeKey: 'business', archived: true },
];

const ALL_PROJECT_KEYS = [...PAGE_1_PROJECTS, ...PAGE_2_PROJECTS].map(p => p.key);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedConnection(overrides = {}) {
  const id = uuidv4();
  const conn = {
    id,
    cloudId:             'cloud-pagination-test',
    siteName:            'Pagination Test Site',
    siteUrl:             'https://pagination-test.atlassian.net',
    status:              'active',
    grantedScopes:       ['manage:jira-webhook', 'read:jira-work', 'read:field:jira'],
    accessToken:         'enc:mock-access-token-pagination',
    refreshToken:        'enc:mock-refresh-token-pagination',
    accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    projectScopeMode:    'all',
    selectedProjectIds:  [],
    userId:              'qa-test-user-pagination',
    createdAt:           new Date().toISOString(),
    updatedAt:           new Date().toISOString(),
    lastSyncedAt:        null,
    ...overrides,
  };
  db.connections.set(id, conn);
  return conn;
}

/**
 * Install axios mocks for a full two-page project enumeration backup run.
 * Tracks how many times /project/search is called and with which startAt.
 */
function mockBackupApiCallsMultiPage() {
  const projectSearchCalls = [];

  axios.get.mockImplementation((url, config) => {
    // Webhook check
    if (url.includes('/rest/api/3/webhook')) {
      return Promise.resolve({ data: { values: [], isLast: true } });
    }

    // Workflow enumeration
    if (url.includes('/rest/api/3/workflow/search')) {
      return Promise.resolve({
        data: { values: [{ id: 'wf-pag-1', name: 'Default Workflow' }], isLast: true },
      });
    }

    // Custom field list
    if (url.match(/\/rest\/api\/3\/field($|\?)/)) {
      return Promise.resolve({
        data: [{ id: 'customfield_10100', name: 'Epic Link', schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:text' } }],
      });
    }

    // Custom field context
    if (url.includes('/field/customfield_10100/context')) {
      return Promise.resolve({
        data: { values: [{ id: 'ctx-pag-1', name: 'Global', isGlobalContext: true }], isLast: true },
      });
    }

    // Project search — two pages
    if (url.includes('/rest/api/3/project/search')) {
      const startAt = (config && config.params && config.params.startAt) || 0;
      projectSearchCalls.push(startAt);

      if (startAt === 0) {
        return Promise.resolve({
          data: { values: PAGE_1_PROJECTS, isLast: false, total: 5 },
        });
      }
      if (startAt === PAGE_1_PROJECTS.length) {
        return Promise.resolve({
          data: { values: PAGE_2_PROJECTS, isLast: true, total: 5 },
        });
      }
      // Should not be reached in a correct implementation
      return Promise.resolve({ data: { values: [], isLast: true, total: 5 } });
    }

    // JQL issue search — return empty for every project so no issue enumeration cost
    if (url.includes('/rest/api/3/search')) {
      return Promise.resolve({
        data: { issues: [], total: 0, startAt: 0, maxResults: 100 },
      });
    }

    return Promise.reject(new Error(`Unexpected axios.get: ${url}`));
  });

  axios.post.mockImplementation((url) => {
    if (url.includes('/rest/api/3/webhook')) {
      return Promise.resolve({
        data: { webhookRegistrationResult: [{ createdWebhookId: 77701 }] },
      });
    }
    return Promise.reject(new Error(`Unexpected axios.post: ${url}`));
  });

  return { projectSearchCalls };
}

/**
 * Single-page mock: isLast=true on the first response.
 */
function mockBackupApiCallsSinglePage() {
  axios.get.mockImplementation((url) => {
    if (url.includes('/rest/api/3/webhook')) {
      return Promise.resolve({ data: { values: [], isLast: true } });
    }
    if (url.includes('/rest/api/3/workflow/search')) {
      return Promise.resolve({ data: { values: [], isLast: true } });
    }
    if (url.match(/\/rest\/api\/3\/field($|\?)/)) {
      return Promise.resolve({ data: [] });
    }
    if (url.includes('/rest/api/3/project/search')) {
      return Promise.resolve({
        data: { values: PAGE_1_PROJECTS, isLast: true, total: PAGE_1_PROJECTS.length },
      });
    }
    if (url.includes('/rest/api/3/search')) {
      return Promise.resolve({ data: { issues: [], total: 0, startAt: 0, maxResults: 100 } });
    }
    return Promise.reject(new Error(`Unexpected axios.get: ${url}`));
  });

  axios.post.mockImplementation(() =>
    Promise.resolve({ data: { webhookRegistrationResult: [{ createdWebhookId: 77705 }] } })
  );
}

/**
 * Poll until backup job leaves 'running' status.
 */
async function waitForJob(jobId, integrationId, maxWaitMs = 10000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const res = await request(app)
      .get(`/api/connections/${integrationId}/backup/${jobId}`);
    if (res.status !== 200) {
      throw new Error(`Job poll returned ${res.status}: ${JSON.stringify(res.body)}`);
    }
    if (res.body.status !== 'running') return res.body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Job ${jobId} did not reach terminal status within ${maxWaitMs}ms`);
}

// ---------------------------------------------------------------------------
// Reset state before each test
// ---------------------------------------------------------------------------
beforeEach(() => {
  db.connections.clear();
  db.backupJobs.clear();
  db.backupPoints.clear();
  db.backupRunStates.clear();
  db.workflowNodes.clear();
  db.customFieldDefinitions.clear();
  db.customFieldContextNodes.clear();
  db.webhookRegistrations.clear();
  db.attachmentManifestEntries.clear();
  db.issueNodes.clear();
  db.projectNodes.clear();
  db.objectSnapshots.clear();
  jest.clearAllMocks();
});

// ===========================================================================
// TC-PAG-1: All projects from all pages captured in db.projectNodes
// ===========================================================================
describe('TC-PAG-1: All projects from multi-page response captured in db.projectNodes', () => {
  test('5 projects across 2 pages all end up in db.projectNodes', async () => {
    const conn = seedConnection();
    mockBackupApiCallsMultiPage();

    const triggerRes = await request(app).post(`/api/connections/${conn.id}/backup`);
    expect(triggerRes.status).toBe(202);

    const job = await waitForJob(triggerRes.body.jobId, conn.id);
    expect(job.status).toBe('completed');

    // All 5 project keys must be in db.projectNodes
    const storedKeys = [...db.projectNodes.values()]
      .filter(p => p.integrationId === conn.id)
      .map(p => p.key);

    expect(storedKeys.sort()).toEqual(ALL_PROJECT_KEYS.sort());
    expect(storedKeys).toHaveLength(5);
  }, 15000);

  test('projects from page 2 specifically are present (not just page 1)', async () => {
    const conn = seedConnection();
    mockBackupApiCallsMultiPage();

    const triggerRes = await request(app).post(`/api/connections/${conn.id}/backup`);
    await waitForJob(triggerRes.body.jobId, conn.id);

    const storedKeys = [...db.projectNodes.values()]
      .filter(p => p.integrationId === conn.id)
      .map(p => p.key);

    // Page 2 keys must be present
    for (const proj of PAGE_2_PROJECTS) {
      expect(storedKeys).toContain(proj.key);
    }
  }, 15000);
});

// ===========================================================================
// TC-PAG-2: objectCounts.projects reflects all pages
// ===========================================================================
describe('TC-PAG-2: backup point objectCounts.projects equals total across all pages', () => {
  test('objectCounts.projects is 5 (both pages) not 3 (first page only)', async () => {
    const conn = seedConnection();
    mockBackupApiCallsMultiPage();

    const triggerRes = await request(app).post(`/api/connections/${conn.id}/backup`);
    const job = await waitForJob(triggerRes.body.jobId, conn.id);
    expect(job.status).toBe('completed');

    const dbJob = db.backupJobs.get(triggerRes.body.jobId);
    expect(dbJob.backupPointId).toBeDefined();
    const bp = db.backupPoints.get(dbJob.backupPointId);
    expect(bp).toBeDefined();

    // objectCounts.projects must be 5 — both pages captured
    // Pre-bug: would be 3 (only page 1) or 0 if loop broke early
    expect(bp.objectCounts.projects).toBe(5);
  }, 15000);
});

// ===========================================================================
// TC-PAG-3: startAt advances correctly — /project/search called exactly twice
// ===========================================================================
describe('TC-PAG-3: project/search called exactly twice with correct startAt values', () => {
  test('/project/search is called with startAt=0 then startAt=3', async () => {
    const conn = seedConnection();
    const { projectSearchCalls } = mockBackupApiCallsMultiPage();

    const triggerRes = await request(app).post(`/api/connections/${conn.id}/backup`);
    await waitForJob(triggerRes.body.jobId, conn.id);

    // Should have been called exactly twice
    expect(projectSearchCalls).toHaveLength(2);
    // First call: startAt=0
    expect(projectSearchCalls[0]).toBe(0);
    // Second call: startAt=3 (length of page 1)
    expect(projectSearchCalls[1]).toBe(PAGE_1_PROJECTS.length);
  }, 15000);
});

// ===========================================================================
// TC-PAG-4: Fallback to cached projectNodes when /project/search errors
// ===========================================================================
describe('TC-PAG-4: Fallback to cached projectNodes when API errors', () => {
  test('backup completes using cached project keys when /project/search returns 500', async () => {
    const conn = seedConnection();

    // Pre-seed a cached project node for this connection
    db.projectNodes.set(`${conn.id}:CACHED`, {
      integrationId: conn.id,
      cloudId: conn.cloudId,
      projectKey: 'CACHED',
      key: 'CACHED',
      name: 'Cached Project',
    });

    // Make /project/search fail
    axios.get.mockImplementation((url) => {
      if (url.includes('/rest/api/3/webhook')) {
        return Promise.resolve({ data: { values: [], isLast: true } });
      }
      if (url.includes('/rest/api/3/workflow/search')) {
        return Promise.resolve({ data: { values: [], isLast: true } });
      }
      if (url.match(/\/rest\/api\/3\/field($|\?)/)) {
        return Promise.resolve({ data: [] });
      }
      if (url.includes('/rest/api/3/project/search')) {
        return Promise.reject(Object.assign(new Error('Internal Server Error'), {
          isAxiosError: true,
          response: { status: 500, data: {} },
        }));
      }
      if (url.includes('/rest/api/3/search')) {
        return Promise.resolve({ data: { issues: [], total: 0, startAt: 0, maxResults: 100 } });
      }
      return Promise.reject(new Error(`Unexpected axios.get: ${url}`));
    });

    axios.post.mockImplementation(() =>
      Promise.resolve({ data: { webhookRegistrationResult: [{ createdWebhookId: 77704 }] } })
    );

    const triggerRes = await request(app).post(`/api/connections/${conn.id}/backup`);
    expect(triggerRes.status).toBe(202);

    const job = await waitForJob(triggerRes.body.jobId, conn.id);

    // Backup must still complete (fallback path, not crash)
    expect(job.status).toBe('completed');

    // The backup ran against the cached project
    const dbJob = db.backupJobs.get(triggerRes.body.jobId);
    const bp = db.backupPoints.get(dbJob.backupPointId);
    expect(bp).toBeDefined();
    expect(bp.objectCounts.projects).toBe(1); // the one cached project
  }, 15000);
});

// ===========================================================================
// TC-PAG-5: Single-page response (isLast=true on first page)
// ===========================================================================
describe('TC-PAG-5: Single-page project list (isLast=true on first call)', () => {
  test('all 3 projects from single page are stored; no second API call made', async () => {
    const conn = seedConnection();
    mockBackupApiCallsSinglePage();

    const triggerRes = await request(app).post(`/api/connections/${conn.id}/backup`);
    expect(triggerRes.status).toBe(202);

    const job = await waitForJob(triggerRes.body.jobId, conn.id);
    expect(job.status).toBe('completed');

    const storedKeys = [...db.projectNodes.values()]
      .filter(p => p.integrationId === conn.id)
      .map(p => p.key);

    expect(storedKeys.sort()).toEqual(PAGE_1_PROJECTS.map(p => p.key).sort());
    expect(storedKeys).toHaveLength(3);

    // Verify project/search was called only once (isLast=true stopped pagination)
    const projectSearchCallCount = axios.get.mock.calls
      .filter(([url]) => url.includes('/rest/api/3/project/search'))
      .length;
    expect(projectSearchCallCount).toBe(1);
  }, 15000);
});
