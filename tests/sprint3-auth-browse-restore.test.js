'use strict';

/**
 * Sprint 3 — Backup & Restore End-to-End Regression Tests
 * (Auth, Browse, and Restore verification with mocked HTTP layer)
 *
 * Acceptance criteria:
 *   TEST-1  Token expiry mid-backup — proactive refresh fires, backup completes,
 *            new token is persisted in db.connections.
 *   TEST-2  Backup detail API returns objectCounts with non-zero issues and projects.
 *   TEST-3  Restore triggers Jira write APIs (POST /rest/api/3/issue) and returns
 *            restoredCount > 0.
 *
 * All HTTP calls to Atlassian and Jira APIs are intercepted via jest.mock('axios').
 * No live tenant is required.
 */

// ─── Environment setup (must precede any require that reads env) ───────────────
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  '0ae79904e41359173d04fe7a63a93c289db8b411b9467cbc87e4d0646e4c133d';
process.env.ATLASSIAN_CLIENT_ID = 'test-client-id-e2e';
process.env.ATLASSIAN_CLIENT_SECRET = 'test-client-secret-e2e';
process.env.ATLASSIAN_REDIRECT_URI = 'https://localhost:4443/oauth/callback';
process.env.NODE_ENV = 'test';

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock('axios');
jest.mock('../src/services/crypto', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => (typeof v === 'string' ? v.replace(/^enc:/, '') : v),
}));

const axios = require('axios');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const db = require('../src/db');
const app = require('../src/app');

// ─── Controlled mock jiraAxios instance ───────────────────────────────────────
// axios.create() is called at runtime inside createJiraAxiosInstance — we intercept
// it here so every call returns our controllable mock.

const mockJiraGet = jest.fn();
const mockJiraPost = jest.fn();
const mockJiraAxios = {
  get: mockJiraGet,
  post: mockJiraPost,
  interceptors: {
    request: { use: jest.fn() },
    response: { use: jest.fn() },
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clearDb() {
  db.connections.clear();
  db.backupJobs.clear();
  db.backupPoints.clear();
  db.objectSnapshots.clear();
  db.restoreJobs.clear();
  db.restoredObjects.clear();
  db.exportArchives.clear();
  db.projectNodes.clear();
  db.workflowNodes.clear();
  db.customFieldDefinitions.clear();
}

/**
 * Seed a connection with encrypted tokens.
 * accessTokenExpiresAt defaults to 1 hour from now (valid).
 */
function seedConnection(overrides = {}) {
  const id = overrides.id || uuidv4();
  const conn = {
    id,
    cloudId: overrides.cloudId || 'cloud-e2e',
    siteId: overrides.siteId || 'site-e2e',
    siteUrl: overrides.siteUrl || 'https://e2e-test.atlassian.net',
    accessToken: `enc:${overrides.accessToken || 'initial-access-token'}`,
    refreshToken: `enc:${overrides.refreshToken || 'refresh-token-abc'}`,
    accessTokenExpiresAt:
      overrides.accessTokenExpiresAt ||
      new Date(Date.now() + 3_600_000).toISOString(), // 1 hour
    // Pre-verified cloudId so tests that don't cover cloudId verification skip the API call.
    cloudIdVerifiedAt: overrides.cloudIdVerifiedAt !== undefined
      ? overrides.cloudIdVerifiedAt
      : new Date().toISOString(),
    grantedScopes: overrides.grantedScopes || [],     // no webhook scope by default
    deletedAt: null,
    status: overrides.status || 'active',
    projectScopeMode: overrides.projectScopeMode || 'all',
  };
  db.connections.set(id, conn);
  return conn;
}

function seedBackupPoint(integrationId, overrides = {}) {
  const id = overrides.id || uuidv4();
  const bp = {
    id,
    integrationId,
    createdAt: new Date().toISOString(),
    priorBackupPointId: null,
    status: 'completed',
    objectCounts: { issues: 0, projects: 0, workflows: 0, customFields: 0, attachments: 0, boards: 0, sprints: 0 },
    ...(overrides || {}),
  };
  db.backupPoints.set(id, bp);
  return bp;
}

function seedIssueSnapshot(backupPointId, issueId, fields = {}) {
  const key = `${backupPointId}:JiraIssueNode:${issueId}`;
  db.objectSnapshots.set(key, {
    backupPointId,
    nodeType: 'JiraIssueNode',
    id: issueId,
    fields: {
      key: `PROJ-${issueId}`,
      summary: `Test issue ${issueId}`,
      issuetype: { name: 'Task' },
      project: { key: 'PROJ' },
      labels: [],
      ...fields,
    },
    issueKey: `PROJ-${issueId}`,
  });
}

/**
 * Set up mockJiraGet with standard responses for a backup run.
 *
 * URL patterns handled:
 *   /project/search      → 1 project ("PROJ")
 *   /rest/api/3/search   → 2 issues (JQL enumeration)
 *   /workflow/search     → 1 workflow (site enumeration)
 *   /rest/api/3/field    → 1 custom field + 1 system field
 *   /context             → empty context list (safe 404-style empty)
 */
function setupJiraMockForBackup({ projectKeys = ['PROJ'], issues = null } = {}) {
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
    {
      id: 'issue-002',
      key: 'PROJ-2',
      fields: {
        summary: 'Issue two',
        issuetype: { name: 'Bug' },
        project: { key: 'PROJ' },
        labels: [],
        attachment: [],
        updated: new Date().toISOString(),
      },
    },
  ];

  const issueList = issues || defaultIssues;

  mockJiraGet.mockImplementation((url) => {
    const urlStr = String(url);

    if (urlStr.includes('/project/search')) {
      return Promise.resolve({
        data: {
          values: projectKeys.map((key) => ({
            id: `id-${key}`,
            key,
            name: `Project ${key}`,
            projectTypeKey: 'software',
            archived: false,
          })),
          isLast: true,
        },
      });
    }

    // Workflow search must come BEFORE generic /search check (workflow URL contains '/search')
    if (urlStr.includes('/workflow/search')) {
      return Promise.resolve({
        data: {
          values: [
            { id: 'wf-1', name: 'Software Simplified Workflow', description: 'Default', statuses: [], transitions: [] },
          ],
          isLast: true,
        },
      });
    }

    if (urlStr.includes('/rest/api/3/search')) {
      return Promise.resolve({
        data: {
          issues: issueList,
          total: issueList.length,
          startAt: 0,
          maxResults: 50,
        },
      });
    }

    // Custom field context — must come BEFORE /rest/api/3/field check.
    // Context URL (.../field/customfield_X/context) contains '/rest/api/3/field' as a prefix,
    // so if the field check ran first it would return an array instead of { values, isLast }.
    if (urlStr.includes('/context')) {
      return Promise.resolve({ data: { values: [], isLast: true } });
    }

    if (urlStr.includes('/rest/api/3/field')) {
      return Promise.resolve({
        data: [
          { id: 'customfield_10000', name: 'Story Points', schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' } },
          { id: 'status', name: 'Status', schema: { type: 'status' } }, // system field — no context call
        ],
      });
    }

    // Fallback — unexpected URL
    return Promise.reject(
      Object.assign(new Error(`Unexpected GET: ${urlStr}`), { response: { status: 404 } })
    );
  });
}

/**
 * Poll the backup job status until it leaves 'running' or we time out.
 * Returns the final response body.
 */
async function waitForBackupJob(jobId, integrationId, { maxAttempts = 20, intervalMs = 50 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await request(app).get(`/api/v1/integrations/${integrationId}/backup/${jobId}`);
    if (res.body.status !== 'running') return res.body;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitForBackupJob timed out after ${maxAttempts} attempts`);
}

/**
 * Poll the restore job status until it leaves 'running' or we time out.
 */
async function waitForRestoreJob(jobId, integrationId, { maxAttempts = 20, intervalMs = 50 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await request(app).get(`/api/v1/integrations/${integrationId}/restore-backup/${jobId}`);
    if (res.body.status !== 'running') return res.body;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitForRestoreJob timed out after ${maxAttempts} attempts`);
}

// ─── Module-level setup ───────────────────────────────────────────────────────

beforeEach(() => {
  clearDb();
  jest.clearAllMocks();

  // Every call to axios.create() returns our controllable mock instance.
  axios.create.mockReturnValue(mockJiraAxios);

  // Reset mock functions so each test starts clean.
  mockJiraGet.mockReset();
  mockJiraPost.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST-1: Proactive token refresh fires when token expires within 5 minutes,
//         backup completes successfully, and new token is persisted.
// ─────────────────────────────────────────────────────────────────────────────

describe('TEST-1 — Proactive token refresh: backup completes and new token persisted', () => {
  test('backup completes after proactive token refresh when access token expires in <5 min', async () => {
    // Seed a connection whose token expires in 2 minutes (within the 5-min refresh buffer).
    const conn = seedConnection({
      accessTokenExpiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(), // 2 min
      accessToken: 'expiring-token',
      refreshToken: 'valid-refresh-token',
    });

    // Mock the Atlassian token endpoint — returns a fresh token.
    axios.post.mockResolvedValueOnce({
      data: {
        access_token: 'refreshed-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      },
    });

    // After the refresh, createJiraAxiosInstance will be called with the new token.
    // Our mockJiraAxios is already returned by axios.create.
    setupJiraMockForBackup();

    // Trigger backup
    const triggerRes = await request(app)
      .post(`/api/v1/integrations/${conn.id}/backup`)
      .send({});

    expect(triggerRes.status).toBe(202);
    const { jobId } = triggerRes.body;
    expect(jobId).toBeDefined();

    // Wait for the async job to complete.
    const finalJob = await waitForBackupJob(jobId, conn.id);

    // AC: backup job reports 'completed' (not 'failed').
    expect(finalJob.status).toBe('completed');

    // AC: the Atlassian token endpoint was called exactly once (the proactive refresh).
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      'https://auth.atlassian.com/oauth/token',
      expect.objectContaining({
        grant_type: 'refresh_token',
        refresh_token: 'valid-refresh-token',
      })
    );

    // AC: new tokens are persisted in db.connections (encrypted).
    const updatedConn = db.connections.get(conn.id);
    expect(updatedConn).toBeDefined();
    expect(updatedConn.accessToken).toBe('enc:refreshed-access-token');
    expect(updatedConn.refreshToken).toBe('enc:new-refresh-token');

    // AC: expiry is in the future (new token, not the old near-expiry one).
    const newExpiry = new Date(updatedConn.accessTokenExpiresAt).getTime();
    expect(newExpiry).toBeGreaterThan(Date.now() + 55 * 60 * 1000); // at least 55 min from now
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST-2: Backup detail API returns objectCounts with non-zero issues/projects.
// ─────────────────────────────────────────────────────────────────────────────

describe('TEST-2 — Backup detail API returns populated objectCounts', () => {
  test('backup point objectCounts contains non-zero issues and projects after successful backup', async () => {
    const conn = seedConnection();

    setupJiraMockForBackup({
      projectKeys: ['PROJ'],
      issues: [
        {
          id: 'issue-a',
          key: 'PROJ-1',
          fields: { summary: 'Alpha', issuetype: { name: 'Task' }, project: { key: 'PROJ' }, labels: [], attachment: [] },
        },
        {
          id: 'issue-b',
          key: 'PROJ-2',
          fields: { summary: 'Beta', issuetype: { name: 'Bug' }, project: { key: 'PROJ' }, labels: [], attachment: [] },
        },
        {
          id: 'issue-c',
          key: 'PROJ-3',
          fields: { summary: 'Gamma', issuetype: { name: 'Story' }, project: { key: 'PROJ' }, labels: [], attachment: [] },
        },
      ],
    });

    // Trigger backup
    const triggerRes = await request(app)
      .post(`/api/v1/integrations/${conn.id}/backup`)
      .send({});

    expect(triggerRes.status).toBe(202);
    const { jobId } = triggerRes.body;

    // Wait for completion
    const finalJob = await waitForBackupJob(jobId, conn.id);

    expect(finalJob.status).toBe('completed');

    // AC: objectCounts is present in the poll response.
    expect(finalJob.objectCounts).toBeDefined();

    // AC: issues count is non-zero (we backed up 3 issues).
    expect(typeof finalJob.objectCounts.issues).toBe('number');
    expect(finalJob.objectCounts.issues).toBeGreaterThan(0);

    // AC: projects count is non-zero (we backed up 1 project: PROJ).
    expect(typeof finalJob.objectCounts.projects).toBe('number');
    expect(finalJob.objectCounts.projects).toBeGreaterThan(0);

    // AC: objectSnapshots were stored so a future restore can build a basket.
    const snapshotKeys = [...db.objectSnapshots.keys()];
    const issueSnapshots = snapshotKeys.filter((k) => k.includes('JiraIssueNode'));
    expect(issueSnapshots.length).toBeGreaterThan(0);
  });

  test('objectCounts.workflows is populated when workflows are returned by Jira', async () => {
    const conn = seedConnection();

    setupJiraMockForBackup();

    const triggerRes = await request(app)
      .post(`/api/v1/integrations/${conn.id}/backup`)
      .send({});

    expect(triggerRes.status).toBe(202);
    const finalJob = await waitForBackupJob(triggerRes.body.jobId, conn.id);

    expect(finalJob.status).toBe('completed');
    expect(finalJob.objectCounts.workflows).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST-3: Restore calls Jira write APIs and returns restoredCount > 0.
// ─────────────────────────────────────────────────────────────────────────────

describe('TEST-3 — Restore verification: Jira write APIs called and restoredCount > 0', () => {
  test('restore with original destination calls POST /rest/api/3/issue and returns restoredCount > 0', async () => {
    const conn = seedConnection({ cloudId: 'cloud-restore-test' });

    // Seed a backup point with 2 issue snapshots.
    const bp = seedBackupPoint(conn.id);
    seedIssueSnapshot(bp.id, 'restore-issue-1', { key: 'PROJ-1', summary: 'First issue', project: { key: 'PROJ' } });
    seedIssueSnapshot(bp.id, 'restore-issue-2', { key: 'PROJ-2', summary: 'Second issue', project: { key: 'PROJ' } });

    // Mock the Jira issue creation endpoint — returns a new issue key each call.
    let issueCallCount = 0;
    mockJiraPost.mockImplementation((url) => {
      const urlStr = String(url);
      if (urlStr.includes('/rest/api/3/issue')) {
        issueCallCount += 1;
        return Promise.resolve({
          data: { id: `new-issue-${issueCallCount}`, key: `PROJ-${100 + issueCallCount}` },
        });
      }
      return Promise.reject(new Error(`Unexpected POST: ${urlStr}`));
    });

    // Trigger restore with 'original' destination — this triggers Jira API writes.
    const postRes = await request(app)
      .post(`/api/v1/integrations/${conn.id}/restore-backup`)
      .send({
        backupPointId: bp.id,
        destination: { type: 'original', originalSiteId: 'cloud-restore-test', originalProjectKey: 'PROJ' },
        conflictMode: 'skip',
        objectSelection: { includeAll: true },
      });

    expect(postRes.status).toBe(202);
    const { jobId } = postRes.body;
    expect(jobId).toBeDefined();

    // Wait for the fire-and-forget job to complete.
    await new Promise((resolve) => setImmediate(resolve));
    const finalJob = await waitForRestoreJob(jobId, conn.id);

    // AC: restore job completed.
    expect(finalJob.status).toBe('complete');

    // AC: restoredCount > 0 (both issues restored).
    expect(typeof finalJob.restoredCount).toBe('number');
    expect(finalJob.restoredCount).toBeGreaterThan(0);

    // AC: the mock Jira issue endpoint was actually called (write happened).
    const issuePosts = mockJiraPost.mock.calls.filter(([url]) =>
      String(url).includes('/rest/api/3/issue')
    );
    expect(issuePosts.length).toBeGreaterThan(0);

    // AC: the payloads sent to Jira include the required original-key label (ADR-004).
    for (const [, payload] of issuePosts) {
      expect(payload).toBeDefined();
      const labels = payload && payload.fields && payload.fields.labels;
      expect(Array.isArray(labels)).toBe(true);
      const hasOriginalKeyLabel = labels.some((l) => String(l).startsWith('original-key:'));
      expect(hasOriginalKeyLabel).toBe(true);
    }

    // AC: restoredCount equals number of issue snapshots we seeded (2).
    expect(finalJob.restoredCount).toBe(2);
    expect(finalJob.failedCount).toBe(0);
  });

  test('restore poll endpoint returns 404 for unknown jobId', async () => {
    const conn = seedConnection();
    const res = await request(app).get(
      `/api/v1/integrations/${conn.id}/restore-backup/nonexistent-job-id`
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('RESTORE_JOB_NOT_FOUND');
  });

  test('restore with export destination does NOT call Jira write APIs', async () => {
    const conn = seedConnection();
    const bp = seedBackupPoint(conn.id);
    seedIssueSnapshot(bp.id, 'export-issue-1');
    seedIssueSnapshot(bp.id, 'export-issue-2');

    // No mockJiraPost setup — any call would throw an unhandled rejection.
    mockJiraPost.mockRejectedValue(new Error('Unexpected Jira POST during export restore'));

    const postRes = await request(app)
      .post(`/api/v1/integrations/${conn.id}/restore-backup`)
      .send({
        backupPointId: bp.id,
        destination: { type: 'export', exportFormat: 'json' },
        conflictMode: 'skip',
        objectSelection: { includeAll: true },
      });

    expect(postRes.status).toBe(202);
    await new Promise((resolve) => setImmediate(resolve));
    const finalJob = await waitForRestoreJob(postRes.body.jobId, conn.id);

    expect(finalJob.status).toBe('complete');
    expect(finalJob.restoredCount).toBe(2);

    // AC: Jira write API was NOT called for export destination.
    const jiraPostCalls = mockJiraPost.mock.calls.filter(([url]) =>
      String(url).includes('api.atlassian.com')
    );
    expect(jiraPostCalls.length).toBe(0);
  });
});
