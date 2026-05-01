'use strict';

/**
 * Sprint 17 — CloudId Verification & 410 Fix Tests
 *
 * Covers all acceptance criteria:
 *   AC-1  A 410 on /rest/api/3/search is fixed by the corrected URL (/search/jql)
 *   AC-2  verifyAndRefreshCloudId calls accessible-resources when cloudIdVerifiedAt is null
 *   AC-3  verifyAndRefreshCloudId skips accessible-resources when verified within 24h
 *   AC-4  verifyAndRefreshCloudId updates cloudId when accessible-resources returns a new id
 *   AC-5  verifyAndRefreshCloudId sets CLOUD_ID_NOT_FOUND status and throws when no site matches
 *   AC-6  cloudIdVerifiedAt is persisted to the connection record after successful verification
 *   AC-7  Backup job fails with CLOUD_ID_NOT_FOUND status when site is not found
 */

// ---------------------------------------------------------------------------
// Environment setup — must precede any require()
// ---------------------------------------------------------------------------
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '0ae79904e41359173d04fe7a63a93c289db8b411b9467cbc87e4d0646e4c133d';
process.env.ATLASSIAN_CLIENT_ID        = 'test-client-id-sprint17';
process.env.ATLASSIAN_CLIENT_SECRET    = 'test-client-secret-sprint17';
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

const axios   = require('axios');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const db  = require('../src/db');
const app = require('../src/app');
const { verifyAndRefreshCloudId } = require('../src/services/tokenService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACCESSIBLE_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

function seedConnection(overrides = {}) {
  const id = uuidv4();
  const conn = {
    id,
    cloudId:              'cloud-sprint17',
    siteName:             'Sprint17 Test Site',
    siteUrl:              'https://sprint17-test.atlassian.net',
    status:               'active',
    clientId:             process.env.ATLASSIAN_CLIENT_ID,
    clientSecret:         `enc:${process.env.ATLASSIAN_CLIENT_SECRET}`,
    accessToken:          'enc:initial-access-token',
    refreshToken:         'enc:initial-refresh-token',
    accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    cloudIdVerifiedAt:    null,
    grantedScopes:        ['read:jira-work', 'manage:jira-webhook'],
    projectScopeMode:     'all',
    selectedProjectIds:   [],
    userId:               'user-sprint17',
    createdAt:            new Date().toISOString(),
    updatedAt:            new Date().toISOString(),
    lastSyncedAt:         null,
    ...overrides,
  };
  db.connections.set(id, conn);
  return conn;
}

function mockAccessibleResources(sites) {
  axios.get.mockImplementation((url) => {
    if (url === ACCESSIBLE_RESOURCES_URL) {
      return Promise.resolve({ data: sites });
    }
    return Promise.reject(new Error(`Unexpected GET: ${url}`));
  });
}

function mockAccessibleResourcesError(statusCode = 500) {
  axios.get.mockImplementation((url) => {
    if (url === ACCESSIBLE_RESOURCES_URL) {
      const err = Object.assign(new Error('Service unavailable'), {
        isAxiosError: true,
        response: { status: statusCode },
      });
      return Promise.reject(err);
    }
    return Promise.reject(new Error(`Unexpected GET: ${url}`));
  });
}

async function waitForJob(jobId, integrationId, maxWaitMs = 8000) {
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
  jest.clearAllMocks();
});

// ===========================================================================
// AC-1: /rest/api/3/search/jql is the correct URL (not /rest/api/3/search)
// ===========================================================================
describe('AC-1: jqlEnumeration uses /rest/api/3/search/jql endpoint', () => {
  test('fetchIssuePage calls /rest/api/3/search/jql not /rest/api/3/search', () => {
    const { fetchIssuePage } = require('../src/services/jqlEnumeration');
    // Verify the URL constant by inspecting what URL the function would call.
    // We check by mocking a successful GET and capturing the URL.
    const mockJiraAxios = {
      get: jest.fn().mockResolvedValueOnce({
        data: { issues: [], total: 0, maxResults: 100, startAt: 0 },
      }),
    };

    const cloudId = 'test-cloud-id';
    const jql = 'project="TEST" ORDER BY updated ASC';

    return fetchIssuePage(cloudId, mockJiraAxios, jql, 0).then(() => {
      const calledUrl = mockJiraAxios.get.mock.calls[0][0];
      expect(calledUrl).toContain('/rest/api/3/search/jql');
      expect(calledUrl).not.toMatch(/\/rest\/api\/3\/search$/);
      expect(calledUrl).not.toMatch(/\/rest\/api\/3\/search\?/);
    });
  });
});

// ===========================================================================
// AC-2: verifyAndRefreshCloudId calls accessible-resources when cloudIdVerifiedAt is null
// ===========================================================================
describe('AC-2: cloudIdVerifiedAt null triggers accessible-resources call', () => {
  test('calls accessible-resources and persists cloudIdVerifiedAt when null', async () => {
    const conn = seedConnection({ cloudIdVerifiedAt: null });

    mockAccessibleResources([
      { id: 'cloud-sprint17', url: 'https://sprint17-test.atlassian.net', name: 'Sprint17 Test Site' },
    ]);

    const cloudId = await verifyAndRefreshCloudId(conn.id);

    expect(cloudId).toBe('cloud-sprint17');
    expect(axios.get).toHaveBeenCalledWith(
      ACCESSIBLE_RESOURCES_URL,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringContaining('Bearer') }) })
    );

    const updated = db.connections.get(conn.id);
    expect(updated.cloudIdVerifiedAt).toBeDefined();
    expect(new Date(updated.cloudIdVerifiedAt).getTime()).toBeGreaterThan(Date.now() - 5000);
  });
});

// ===========================================================================
// AC-3: verifyAndRefreshCloudId skips the API call when verified within 24h
// ===========================================================================
describe('AC-3: cloudIdVerifiedAt within 24h skips accessible-resources', () => {
  test('does NOT call accessible-resources when cloudIdVerifiedAt is recent', async () => {
    const conn = seedConnection({
      cloudIdVerifiedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
    });

    const cloudId = await verifyAndRefreshCloudId(conn.id);

    expect(cloudId).toBe('cloud-sprint17');
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('calls accessible-resources when cloudIdVerifiedAt is older than 24h', async () => {
    const conn = seedConnection({
      cloudIdVerifiedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
    });

    mockAccessibleResources([
      { id: 'cloud-sprint17', url: 'https://sprint17-test.atlassian.net', name: 'Sprint17 Test Site' },
    ]);

    await verifyAndRefreshCloudId(conn.id);

    expect(axios.get).toHaveBeenCalledWith(ACCESSIBLE_RESOURCES_URL, expect.any(Object));
  });
});

// ===========================================================================
// AC-4: cloudId updated when accessible-resources returns a new cloudId
// ===========================================================================
describe('AC-4: cloudId is updated when accessible-resources returns a migrated id', () => {
  test('persists new cloudId when accessible-resources returns a different id for the same site', async () => {
    const conn = seedConnection({
      cloudId: 'old-cloud-id',
      cloudIdVerifiedAt: null,
    });

    mockAccessibleResources([
      // Same siteUrl but different id (site migration scenario)
      { id: 'new-cloud-id', url: 'https://sprint17-test.atlassian.net', name: 'Sprint17 Test Site' },
    ]);

    const cloudId = await verifyAndRefreshCloudId(conn.id);

    expect(cloudId).toBe('new-cloud-id');

    const updated = db.connections.get(conn.id);
    expect(updated.cloudId).toBe('new-cloud-id');
    expect(updated.cloudIdVerifiedAt).toBeDefined();
  });
});

// ===========================================================================
// AC-5: CLOUD_ID_NOT_FOUND when no matching site
// ===========================================================================
describe('AC-5: CLOUD_ID_NOT_FOUND when site is missing from accessible-resources', () => {
  test('sets connection status to CLOUD_ID_NOT_FOUND and throws', async () => {
    const conn = seedConnection({ cloudIdVerifiedAt: null });

    // Accessible-resources returns sites but none match this connection
    mockAccessibleResources([
      { id: 'other-cloud-id', url: 'https://other-site.atlassian.net', name: 'Other Site' },
    ]);

    await expect(verifyAndRefreshCloudId(conn.id)).rejects.toMatchObject({
      code: 'CLOUD_ID_NOT_FOUND',
    });

    const updated = db.connections.get(conn.id);
    expect(updated.status).toBe('CLOUD_ID_NOT_FOUND');
  });

  test('throws with a descriptive human-readable message', async () => {
    const conn = seedConnection({ cloudIdVerifiedAt: null });

    mockAccessibleResources([]); // Empty list — no sites at all

    await expect(verifyAndRefreshCloudId(conn.id)).rejects.toMatchObject({
      code: 'CLOUD_ID_NOT_FOUND',
      message: expect.stringContaining('reconnect'),
    });
  });
});

// ===========================================================================
// AC-6: cloudIdVerifiedAt is persisted after successful verification
// ===========================================================================
describe('AC-6: cloudIdVerifiedAt is persisted to connection record', () => {
  test('cloudIdVerifiedAt is an ISO string set to approximately now', async () => {
    const conn = seedConnection({ cloudIdVerifiedAt: null });

    mockAccessibleResources([
      { id: 'cloud-sprint17', url: 'https://sprint17-test.atlassian.net', name: 'Sprint17 Test Site' },
    ]);

    const before = Date.now();
    await verifyAndRefreshCloudId(conn.id);
    const after = Date.now();

    const updated = db.connections.get(conn.id);
    expect(updated.cloudIdVerifiedAt).toBeDefined();

    const ts = new Date(updated.cloudIdVerifiedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 100);
  });
});

// ===========================================================================
// AC-7: Backup job fails with cloud_id_not_found status when site is missing
// ===========================================================================
describe('AC-7: Backup job surfaces cloud_id_not_found when site is gone', () => {
  test('backup job status is cloud_id_not_found when accessible-resources returns no matching site', async () => {
    const conn = seedConnection({ cloudIdVerifiedAt: null });

    // Accessible-resources returns a site that doesn't match this connection
    mockAccessibleResources([
      { id: 'unrelated-cloud', url: 'https://unrelated.atlassian.net', name: 'Unrelated Site' },
    ]);

    const triggerRes = await request(app)
      .post(`/api/connections/${conn.id}/backup`);

    expect(triggerRes.status).toBe(202);
    const { jobId } = triggerRes.body;

    const job = await waitForJob(jobId, conn.id);

    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/reconnect|CLOUD_ID_NOT_FOUND/i);

    const updatedConn = db.connections.get(conn.id);
    expect(updatedConn.status).toBe('CLOUD_ID_NOT_FOUND');
  }, 12000);
});
