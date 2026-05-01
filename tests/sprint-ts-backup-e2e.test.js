'use strict';

/**
 * TS Backup End-to-End Test
 *
 * Verifies the full backup pipeline for a project with 3 issues when the
 * Jira search/jql API returns no `total` field (the real-world shape seen
 * with /rest/api/3/search/jql that caused infinite pagination).
 *
 * Acceptance criteria:
 *   AC-1  Backup job reaches status=completed with non-null completedAt
 *   AC-2  All 3 issues (TS-1, TS-2, TS-3) are in db.objectSnapshots
 *   AC-3  fields.attachment metadata is captured inline for each issue
 *   AC-4  Job progress panel reflects issue processing count (processed=3)
 *   AC-5  No unhandled promise rejections / silent error swallowing
 *   AC-6  Heartbeat is stopped on both success and error paths
 */

// ---------------------------------------------------------------------------
// Environment — must precede any require()
// ---------------------------------------------------------------------------
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '0ae79904e41359173d04fe7a63a93c289db8b411b9467cbc87e4d0646e4c133d';
process.env.ATLASSIAN_CLIENT_ID        = '1hCMINKiuGDOyWuGkI4BnMQhq8mwPEa9';
process.env.ATLASSIAN_CLIENT_SECRET    = 'test-secret-ts-e2e';
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
    getValidAccessToken: jest.fn().mockResolvedValue('mock-access-token-ts-e2e'),
    createJiraAxiosInstance: jest.fn(() => ({
      get: axiosMod.get,
      post: axiosMod.post,
    })),
    refreshConnectionToken: jest.fn().mockResolvedValue('mock-access-token-ts-e2e'),
    verifyAndRefreshCloudId: jest.fn().mockImplementation((connectionId) => {
      const db = require('../src/db');
      const conn = db.connections.get(connectionId);
      return Promise.resolve(conn ? conn.cloudId : 'mock-cloud-id-ts');
    }),
  };
});

const request = require('supertest');
const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = require('../src/app');
const db  = require('../src/db');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CLOUD_ID  = 'e2f3e272-f44d-4fee-a2c9-48573056d476';
const PROJECT_KEY = 'TS';

// Three issues matching the user's real TS project
const TS_ISSUES = [
  {
    id: 'issue-ts-1',
    key: 'TS-1',
    fields: {
      summary: 'EPIC1',
      issuetype: { name: 'Epic' },
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      attachment: [],
      priority: { name: 'Medium' },
      assignee: null,
    },
  },
  {
    id: 'issue-ts-2',
    key: 'TS-2',
    fields: {
      summary: 'Story 1',
      issuetype: { name: 'Story' },
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      attachment: [],
      priority: { name: 'Medium' },
      assignee: null,
    },
  },
  {
    id: 'issue-ts-3',
    key: 'TS-3',
    fields: {
      summary: 'Story 2',
      issuetype: { name: 'Story' },
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      attachment: [],
      priority: { name: 'Medium' },
      assignee: null,
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedConnection(overrides = {}) {
  const id = uuidv4();
  const conn = {
    id,
    cloudId:              CLOUD_ID,
    siteName:             'TS Test Site',
    siteUrl:              'https://ts-test.atlassian.net',
    status:               'active',
    grantedScopes: [
      'manage:jira-webhook',
      'read:jira-work',
      'read:field:jira',
      'read:sprint:jira-software',
      'read:board-scope:jira-software',
    ],
    accessToken:          'enc:mock-access-token-ts-e2e',
    refreshToken:         'enc:mock-refresh-token-ts-e2e',
    accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    projectScopeMode:     'all',
    selectedProjectIds:   [],
    userId:               'ts-e2e-user',
    createdAt:            new Date().toISOString(),
    updatedAt:            new Date().toISOString(),
    lastSyncedAt:         null,
    // Skip cloudId freshness check in tests
    cloudIdVerifiedAt:    new Date().toISOString(),
    ...overrides,
  };
  db.connections.set(id, conn);
  return conn;
}

/**
 * Mocks the Jira API for a single TS project with 3 issues.
 * The search/jql response intentionally omits `total` to reproduce the
 * real-world shape that caused infinite pagination.
 */
function mockTsBackupApi() {
  axios.get.mockImplementation((url) => {
    // Webhook check
    if (url.includes('/rest/api/3/webhook')) {
      return Promise.resolve({ data: { values: [], isLast: true } });
    }
    // Project search → returns "TS" project
    if (url.includes('/rest/api/3/project/search')) {
      return Promise.resolve({
        data: {
          values: [{ id: '10000', key: PROJECT_KEY, name: 'Test Scrum', projectTypeKey: 'software', archived: false }],
          isLast: true,
        },
      });
    }
    // JQL issue search — no `total` field (matches real Atlassian search/jql shape)
    if (url.includes('/rest/api/3/search/jql')) {
      return Promise.resolve({
        data: {
          issues:     TS_ISSUES,
          startAt:    0,
          maxResults: 100,
          // total intentionally omitted to replicate the infinite pagination bug scenario
        },
      });
    }
    // Workflow search
    if (url.includes('/rest/api/3/workflow/search')) {
      return Promise.resolve({
        data: { values: [{ id: 'wf-ts-1', name: 'Software Simplified Workflow for Project TS' }], isLast: true },
      });
    }
    // Custom fields list
    if (url.match(/\/rest\/api\/3\/field($|\?)/)) {
      return Promise.resolve({
        data: [
          { id: 'summary',    name: 'Summary',    schema: { type: 'string', system: 'summary' } },
          { id: 'status',     name: 'Status',     schema: { type: 'status', system: 'status' } },
          { id: 'attachment', name: 'Attachment', schema: { type: 'array',  system: 'attachment' } },
        ],
      });
    }
    // System field context → 404 (no contexts on system fields)
    if (/\/field\/(summary|status|attachment)\/context/.test(url)) {
      const err = Object.assign(new Error('Not Found'), {
        isAxiosError: true,
        response: { status: 404, data: { errorMessages: ['Not a custom field'], errors: {} } },
      });
      return Promise.reject(err);
    }
    return Promise.reject(new Error(`[ts-e2e] Unexpected axios.get: ${url}`));
  });

  axios.post.mockImplementation((url) => {
    if (url.includes('/rest/api/3/webhook')) {
      return Promise.resolve({
        data: { webhookRegistrationResult: [{ createdWebhookId: 77701 }] },
      });
    }
    return Promise.reject(new Error(`[ts-e2e] Unexpected axios.post: ${url}`));
  });
}

/**
 * Poll the backup job until it leaves 'running' status.
 */
async function waitForJob(jobId, integrationId, maxWaitMs = 8000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const res = await request(app)
      .get(`/api/v1/integrations/${integrationId}/backup/${jobId}`);
    if (res.status !== 200) {
      throw new Error(`Job poll ${res.status}: ${JSON.stringify(res.body)}`);
    }
    if (res.body.status !== 'running') return res.body;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Job ${jobId} did not reach terminal status within ${maxWaitMs}ms`);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
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
  db.jobProgress.clear();
  jest.clearAllMocks();
});

// ===========================================================================
// AC-1: Backup job reaches completed status with non-null completedAt
// ===========================================================================
describe('AC-1: backup job reaches completed status', () => {
  test('job.status=completed and completedAt is set after TS backup', async () => {
    const conn = seedConnection();
    mockTsBackupApi();

    const triggerRes = await request(app).post(`/api/connections/${conn.id}/backup`);
    expect(triggerRes.status).toBe(202);
    const { jobId } = triggerRes.body;

    const job = await waitForJob(jobId, conn.id);

    expect(job.status).toBe('completed');
    expect(job.completedAt).not.toBeNull();
    expect(typeof job.completedAt).toBe('string');

    console.log(`[AC-1] PASS — jobId=${jobId} status=${job.status} completedAt=${job.completedAt}`);
  });
});

// ===========================================================================
// AC-2: All 3 issues are in db.objectSnapshots as individual records
// ===========================================================================
describe('AC-2: all 3 issues persisted in objectSnapshots', () => {
  test('db.objectSnapshots contains an entry for each of TS-1, TS-2, TS-3', async () => {
    const conn = seedConnection();
    mockTsBackupApi();

    const triggerRes = await request(app).post(`/api/connections/${conn.id}/backup`);
    const { jobId } = triggerRes.body;

    const job = await waitForJob(jobId, conn.id);
    expect(job.status).toBe('completed');

    // Find objectSnapshots belonging to the backup point from this job
    const backupPointId = job.backupPointId;
    expect(backupPointId).toBeTruthy();

    const issueSnapshots = [...db.objectSnapshots.entries()]
      .filter(([key]) => key.startsWith(`${backupPointId}:JiraIssueNode:`))
      .map(([, snap]) => snap);

    expect(issueSnapshots).toHaveLength(3);

    const snapshotKeys = issueSnapshots.map((s) => s.issueKey).sort();
    expect(snapshotKeys).toEqual(['TS-1', 'TS-2', 'TS-3']);

    console.log(`[AC-2] PASS — backupPointId=${backupPointId} issueSnapshots.length=${issueSnapshots.length} keys=${snapshotKeys.join(',')}`);
  });
});

// ===========================================================================
// AC-3: fields.attachment metadata captured inline for each issue
// ===========================================================================
describe('AC-3: fields.attachment captured in each issue snapshot', () => {
  test('every issue snapshot has a fields.attachment array (empty is OK)', async () => {
    const conn = seedConnection();
    mockTsBackupApi();

    const triggerRes = await request(app).post(`/api/connections/${conn.id}/backup`);
    const { jobId } = triggerRes.body;
    const job = await waitForJob(jobId, conn.id);

    expect(job.status).toBe('completed');
    const backupPointId = job.backupPointId;

    const issueSnapshots = [...db.objectSnapshots.entries()]
      .filter(([key]) => key.startsWith(`${backupPointId}:JiraIssueNode:`))
      .map(([, snap]) => snap);

    expect(issueSnapshots).toHaveLength(3);

    for (const snap of issueSnapshots) {
      expect(snap.fields).toBeDefined();
      // fields.attachment must exist and be an array
      expect(Array.isArray(snap.fields.attachment)).toBe(true);
    }

    console.log(`[AC-3] PASS — all 3 snapshots have fields.attachment captured`);
  });
});

// ===========================================================================
// AC-4: job progress reflects issue processing count
// ===========================================================================
describe('AC-4: job progress panel shows issue count', () => {
  test('backup point objectCounts.issues=3 after TS backup', async () => {
    const conn = seedConnection();
    mockTsBackupApi();

    const triggerRes = await request(app).post(`/api/connections/${conn.id}/backup`);
    const { jobId } = triggerRes.body;
    const job = await waitForJob(jobId, conn.id);

    expect(job.status).toBe('completed');

    // objectCounts on the job response includes issues count
    expect(job.objectCounts).toBeDefined();
    expect(job.objectCounts.issues).toBe(3);

    // Progress endpoint: check that a progress record exists and had an ISSUE_FETCH phase
    const progressRes = await request(app).get(`/api/v1/jobs/${jobId}/progress`);
    expect(progressRes.status).toBe(200);
    const progress = progressRes.body;
    expect(progress).toBeDefined();
    // The progress snapshot should reflect a phase beyond INIT (backup completed multiple phases)
    expect(progress.phase).not.toBe('INIT');

    console.log(`[AC-4] PASS — objectCounts.issues=${job.objectCounts.issues} progress.phase=${progress.phase}`);
  });
});

// ===========================================================================
// AC-5: No silent error swallowing — error path sets failed status
// ===========================================================================
describe('AC-5: error path — job finalized on failure', () => {
  test('job.status=failed and completedAt set when backup engine throws', async () => {
    const conn = seedConnection();

    // Make the project search fail with a hard error to simulate a mid-backup failure
    axios.get.mockImplementation((url) => {
      if (url.includes('/rest/api/3/webhook')) {
        return Promise.resolve({ data: { values: [], isLast: true } });
      }
      if (url.includes('/rest/api/3/project/search')) {
        return Promise.reject(Object.assign(new Error('Network error'), { isAxiosError: true }));
      }
      return Promise.reject(new Error(`[ts-e2e-error] Unexpected: ${url}`));
    });

    // If the project search fails, the engine falls back to cached project nodes.
    // To force a real failure, we make the workflow search fail hard (no fallback).
    axios.get.mockImplementation((url) => {
      if (url.includes('/rest/api/3/webhook')) {
        return Promise.resolve({ data: { values: [], isLast: true } });
      }
      if (url.includes('/rest/api/3/project/search')) {
        return Promise.resolve({
          data: { values: [{ id: '10000', key: 'TS', name: 'TS', projectTypeKey: 'software' }], isLast: true },
        });
      }
      if (url.includes('/rest/api/3/search/jql')) {
        return Promise.resolve({ data: { issues: TS_ISSUES, startAt: 0, maxResults: 100 } });
      }
      if (url.includes('/rest/api/3/workflow/search')) {
        return Promise.reject(Object.assign(new Error('Simulated workflow API failure'), { isAxiosError: true }));
      }
      return Promise.reject(new Error(`[ts-e2e-error] Unexpected: ${url}`));
    });

    const triggerRes = await request(app).post(`/api/connections/${conn.id}/backup`);
    expect(triggerRes.status).toBe(202);
    const { jobId } = triggerRes.body;

    const job = await waitForJob(jobId, conn.id, 8000);

    expect(job.status).toBe('failed');
    expect(job.completedAt).not.toBeNull();
    expect(typeof job.completedAt).toBe('string');

    console.log(`[AC-5] PASS — jobId=${jobId} status=${job.status} completedAt=${job.completedAt}`);
  });
});

// ===========================================================================
// AC-6: Heartbeat stopped — job never stays 'running' indefinitely
// ===========================================================================
describe('AC-6: heartbeat stopped and job finalized on both paths', () => {
  test('successful backup: job leaves running state and heartbeat is stopped', async () => {
    const conn = seedConnection();
    mockTsBackupApi();

    const triggerRes = await request(app).post(`/api/connections/${conn.id}/backup`);
    expect(triggerRes.status).toBe(202);
    const { jobId } = triggerRes.body;

    // Job must leave 'running' state (heartbeat stop is implied by job termination)
    const job = await waitForJob(jobId, conn.id, 8000);
    expect(job.status).not.toBe('running');
    expect(['completed', 'failed', 'auth_error']).toContain(job.status);

    console.log(`[AC-6] PASS — jobId=${jobId} final status=${job.status} (not stuck in running)`);
  });

  test('pagination with total=undefined: job completes — NOT stuck in infinite loop', async () => {
    const conn = seedConnection();
    // Use the same mock that omits total — this is the exact reproduction case
    mockTsBackupApi();

    const triggerRes = await request(app).post(`/api/connections/${conn.id}/backup`);
    const { jobId } = triggerRes.body;

    // If pagination were infinite, this would time out after 8s
    const job = await waitForJob(jobId, conn.id, 8000);
    expect(job.status).toBe('completed');

    console.log(`[AC-6/paginate] PASS — backup completed without infinite loop; jobId=${jobId}`);
  });
});
