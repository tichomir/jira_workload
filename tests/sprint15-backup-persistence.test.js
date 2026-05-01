'use strict';

/**
 * Sprint 15 — Backup Persistence Regression Test
 *
 * End-to-end regression test for the backup persistence gap:
 *   backupEngine.runIntegrationBackup() was completing successfully but never
 *   writing a BackupPoint record to db.backupPoints.  History endpoints and
 *   the backups.html page therefore always showed an empty list.
 *
 * Fix location: src/services/backupEngine.js — db.backupPoints.set() added
 * after site enumeration completes.
 *
 * Test chain:
 *   TC-PERSIST-1  Trigger backup → job reaches status=completed with backupPointId
 *   TC-PERSIST-2  GET /api/connections/:id/backups returns the record (no manual seed)
 *   TC-PERSIST-3  GET /api/v1/integrations/:id/backup/:jobId returns job with backupPointId
 *   TC-PERSIST-4  GET /api/connections/:id/backups record matches the job's backupPointId
 *   TC-PERSIST-5  backups.html API surface: both list and job-poll endpoints return
 *                 consistent data (API-level simulation of what the page fetches)
 *
 * FAIL condition (pre-fix): db.backupPoints is never written → TC-PERSIST-2 fails
 *   because backupPoints array is empty even after a completed job.
 * PASS condition (post-fix): engine writes the record → all assertions pass.
 */

// ---------------------------------------------------------------------------
// Environment setup — must precede any require()
// ---------------------------------------------------------------------------
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '0ae79904e41359173d04fe7a63a93c289db8b411b9467cbc87e4d0646e4c133d';
process.env.ATLASSIAN_CLIENT_ID        = '1hCMINKiuGDOyWuGkI4BnMQhq8mwPEa9';
process.env.ATLASSIAN_CLIENT_SECRET    = 'test-secret-sprint15';
process.env.ATLASSIAN_REDIRECT_URI     = 'https://localhost:4443/oauth/callback';
process.env.NODE_ENV                   = 'test';
process.env.FRONTEND_BASE_URL          = 'https://localhost:4443';

// ---------------------------------------------------------------------------
// Mock axios BEFORE any module requires it
// ---------------------------------------------------------------------------
jest.mock('axios');

// Mock crypto so tests do not depend on exact key length/format
jest.mock('../src/services/crypto', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => v.replace(/^enc:/, ''),
}));

const request = require('supertest');
const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = require('../src/app');
const db  = require('../src/db');

// ---------------------------------------------------------------------------
// Mock field list: 3 system fields (would 404 if /context called) + 1 custom
// ---------------------------------------------------------------------------
const MOCK_FIELDS = [
  { id: 'statuscategorychangedate', name: 'Status Category Changed', schema: { type: 'datetime', system: 'statuscategorychangedate' } },
  { id: 'created',                  name: 'Created',                  schema: { type: 'datetime', system: 'created' } },
  { id: 'updated',                  name: 'Updated',                  schema: { type: 'datetime', system: 'updated' } },
  { id: 'customfield_10100',        name: 'Epic Link',                schema: { type: 'string',   custom: 'com.atlassian.jira.plugin.system.customfieldtypes:text' } },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seed an active connection in the in-memory db.
 */
function seedConnection(overrides = {}) {
  const id = uuidv4();
  const conn = {
    id,
    cloudId:            'e2f3e272-f44d-4fee-a2c9-48573056d476',
    siteName:           'Sprint15 Persistence Test Site',
    siteUrl:            'https://sprint15-test.atlassian.net',
    status:             'active',
    grantedScopes: [
      'manage:jira-webhook',
      'read:jira-work',
      'read:field:jira',
      'read:sprint:jira-software',
      'read:board-scope:jira-software',
    ],
    accessToken:        'enc:mock-access-token-sprint15',
    refreshToken:       'enc:mock-refresh-token-sprint15',
    projectScopeMode:   'all',
    selectedProjectIds: [],
    userId:             'qa-test-user-sprint15',
    createdAt:          new Date().toISOString(),
    updatedAt:          new Date().toISOString(),
    lastSyncedAt:       null,
    ...overrides,
  };
  db.connections.set(id, conn);
  return conn;
}

/**
 * Install axios mocks for a full backup run.
 * System-field /context calls are wired to return 404 (regression guard).
 */
function mockBackupApiCalls() {
  axios.get.mockImplementation((url) => {
    if (url.includes('/rest/api/3/webhook')) {
      return Promise.resolve({ data: { values: [], isLast: true } });
    }
    if (url.includes('/rest/api/3/workflow/search')) {
      return Promise.resolve({
        data: {
          values: [
            { id: 'wf-sprint15-1', name: 'Software Development' },
            { id: 'wf-sprint15-2', name: 'Bug Triage' },
          ],
          isLast: true,
        },
      });
    }
    if (url.match(/\/rest\/api\/3\/field($|\?)/) ) {
      return Promise.resolve({ data: MOCK_FIELDS });
    }
    if (url.includes('/field/customfield_10100/context')) {
      return Promise.resolve({
        data: {
          values: [{ id: 'ctx-sprint15-1', name: 'Global Context', isGlobalContext: true }],
          isLast: true,
        },
      });
    }
    // System field /context — 404 (regression guard for sprint 14 fix)
    if (/\/field\/(statuscategorychangedate|created|updated)\/context/.test(url)) {
      const err = Object.assign(new Error('Request failed with status code 404'), {
        isAxiosError: true,
        response: { status: 404, data: { errorMessages: ['Not a custom field'], errors: {} } },
      });
      return Promise.reject(err);
    }
    return Promise.reject(new Error(`Unexpected axios.get: ${url}`));
  });

  axios.post.mockImplementation((url) => {
    if (url.includes('/rest/api/3/webhook')) {
      return Promise.resolve({
        data: { webhookRegistrationResult: [{ createdWebhookId: 99915 }] },
      });
    }
    return Promise.reject(new Error(`Unexpected axios.post: ${url}`));
  });
}

/**
 * Poll GET /api/connections/:id/backup/:jobId until status leaves "running".
 * Throws if terminal status is not reached within maxWaitMs.
 */
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

// ---------------------------------------------------------------------------
// Reset in-memory state before each test
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
  jest.clearAllMocks();
});

// ===========================================================================
// TC-PERSIST-1: Backup job completes and the engine writes a BackupPoint record
// ===========================================================================
describe('TC-PERSIST-1: Backup job completes and engine writes a BackupPoint record', () => {
  test('db.backupPoints is non-empty after a completed backup job', async () => {
    const conn = seedConnection();
    mockBackupApiCalls();

    const triggerRes = await request(app)
      .post(`/api/connections/${conn.id}/backup`);
    expect(triggerRes.status).toBe(202);
    const { jobId } = triggerRes.body;

    const job = await waitForJob(jobId, conn.id);
    expect(job.status).toBe('completed');

    // The engine must have written a BackupPoint record to db.backupPoints.
    // Pre-fix: db.backupPoints is empty after the job completes → FAIL
    // Post-fix: engine writes the record → db.backupPoints has 1 entry → PASS
    expect(db.backupPoints.size).toBeGreaterThan(0);

    // The internal db job record carries the backupPointId set by the route handler
    const dbJob = db.backupJobs.get(jobId);
    expect(dbJob).toBeDefined();
    expect(dbJob.backupPointId).toBeDefined();
    expect(typeof dbJob.backupPointId).toBe('string');
    expect(db.backupPoints.has(dbJob.backupPointId)).toBe(true);

    console.log(`[TC-PERSIST-1] PASS — jobId=${jobId} backupPointId=${dbJob.backupPointId}`);
  }, 12000);
});

// ===========================================================================
// TC-PERSIST-2: GET /api/connections/:id/backups returns the engine-written record
//
// CRITICAL: This test does NOT manually seed db.backupPoints.
// It relies entirely on the backup engine writing the record.
// On the pre-fix codebase this test FAILS because backupPoints is empty.
// On the post-fix codebase this test PASSES.
// ===========================================================================
describe('TC-PERSIST-2: GET /api/connections/:id/backups — engine-written record returned (no manual seed)', () => {
  test('returns at least one backup point with status=completed after engine run', async () => {
    const conn = seedConnection();
    mockBackupApiCalls();

    const triggerRes = await request(app)
      .post(`/api/connections/${conn.id}/backup`);
    expect(triggerRes.status).toBe(202);

    const job = await waitForJob(triggerRes.body.jobId, conn.id);
    expect(job.status).toBe('completed');

    // Verify db.backupPoints was populated by the engine (not seeded manually)
    // Pre-fix codebase: db.backupPoints.size === 0 → listRes returns empty → FAIL
    // Post-fix codebase: db.backupPoints.size === 1 → returns record → PASS
    expect(db.backupPoints.size).toBeGreaterThan(0);

    const listRes = await request(app)
      .get(`/api/connections/${conn.id}/backups`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.integrationId).toBe(conn.id);
    expect(Array.isArray(listRes.body.backupPoints)).toBe(true);
    expect(listRes.body.backupPoints.length).toBeGreaterThanOrEqual(1);
    expect(listRes.body.total).toBeGreaterThanOrEqual(1);

    const bp = listRes.body.backupPoints[0];
    expect(bp.id).toBeDefined();
    expect(bp.status).toBe('completed');
    expect(bp.createdAt).toBeDefined();
    expect(bp.objectCounts).toBeDefined();

    console.log(
      `[TC-PERSIST-2] PASS — jobId=${triggerRes.body.jobId} ` +
      `backupPointId=${bp.id} total=${listRes.body.total}`
    );
  }, 12000);

  test('GET /api/v1/integrations/:id/backups alias also returns the record', async () => {
    const conn = seedConnection();
    mockBackupApiCalls();

    const triggerRes = await request(app)
      .post(`/api/connections/${conn.id}/backup`);
    await waitForJob(triggerRes.body.jobId, conn.id);

    const listRes = await request(app)
      .get(`/api/v1/integrations/${conn.id}/backups`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.backupPoints.length).toBeGreaterThanOrEqual(1);
    console.log(`[TC-PERSIST-2b] PASS — /api/v1/integrations alias works`);
  }, 12000);
});

// ===========================================================================
// TC-PERSIST-3: Internal job record links to a valid BackupPoint in db
// ===========================================================================
describe('TC-PERSIST-3: Internal job record backupPointId links to a valid BackupPoint record', () => {
  test('db job backupPointId resolves to an actual BackupPoint with correct integrationId', async () => {
    const conn = seedConnection();
    mockBackupApiCalls();

    const triggerRes = await request(app)
      .post(`/api/connections/${conn.id}/backup`);
    const { jobId } = triggerRes.body;

    const apiJob = await waitForJob(jobId, conn.id);
    expect(apiJob.status).toBe('completed');

    // Retrieve the internal db job record (contains backupPointId set by route handler)
    const dbJob = db.backupJobs.get(jobId);
    expect(dbJob).toBeDefined();
    expect(dbJob.backupPointId).toBeDefined();

    // The backupPointId must resolve to an actual BackupPoint record
    // Pre-fix: db.backupPoints is empty → get() returns undefined → FAIL
    // Post-fix: engine wrote the record → get() returns the point → PASS
    const bp = db.backupPoints.get(dbJob.backupPointId);
    expect(bp).toBeDefined();
    expect(bp.integrationId).toBe(conn.id);
    expect(bp.status).toBe('completed');

    console.log(`[TC-PERSIST-3] PASS — dbJob.backupPointId=${dbJob.backupPointId} found in db.backupPoints`);
  }, 12000);
});

// ===========================================================================
// TC-PERSIST-4: Backup list entry id matches the db job's backupPointId
// ===========================================================================
describe('TC-PERSIST-4: Backup list entry id matches the db job backupPointId', () => {
  test('/backups list contains the id written by the engine and stored in the job record', async () => {
    const conn = seedConnection();
    mockBackupApiCalls();

    const triggerRes = await request(app)
      .post(`/api/connections/${conn.id}/backup`);
    const { jobId } = triggerRes.body;

    const apiJob = await waitForJob(jobId, conn.id);
    expect(apiJob.status).toBe('completed');

    // Get backupPointId from the internal db job record
    const dbJob = db.backupJobs.get(jobId);
    expect(dbJob.backupPointId).toBeDefined();

    const listRes = await request(app)
      .get(`/api/connections/${conn.id}/backups`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.backupPoints.length).toBeGreaterThanOrEqual(1);

    // Pre-fix: list is empty → ids=[] → toContain fails → FAIL
    // Post-fix: list has the engine-written record → id matches → PASS
    const ids = listRes.body.backupPoints.map((bp) => bp.id);
    expect(ids).toContain(dbJob.backupPointId);

    console.log(`[TC-PERSIST-4] PASS — jobId=${jobId} dbJob.backupPointId=${dbJob.backupPointId} in list ids=[${ids.join(', ')}]`);
  }, 12000);
});

// ===========================================================================
// TC-PERSIST-5: backups.html API surface consistency
// Simulates the two API calls the page makes on load:
//   1. GET /api/connections/:id/backups  (renders the history table)
//   2. GET /api/connections/:id/backup/:jobId  (shows active job banner if running)
// Both must return consistent data with a valid backup record.
// ===========================================================================
describe('TC-PERSIST-5: backups.html API surface — both endpoints return consistent data', () => {
  test('list and job-poll endpoints are consistent after a completed backup', async () => {
    const conn = seedConnection();
    mockBackupApiCalls();

    // --- Step 1: Trigger ---
    const triggerRes = await request(app)
      .post(`/api/connections/${conn.id}/backup`);
    expect(triggerRes.status).toBe(202);
    const { jobId } = triggerRes.body;

    // --- Step 2: Wait for job completion ---
    const completedJob = await waitForJob(jobId, conn.id);
    expect(completedJob.status).toBe('completed');

    // --- Step 3: Simulate backups.html history table fetch ---
    const listRes = await request(app)
      .get(`/api/connections/${conn.id}/backups`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.integrationId).toBe(conn.id);
    // PRE-FIX: this array would be empty → UI shows no backup history → bug
    // POST-FIX: array contains the engine-written record → UI shows backup entry
    expect(listRes.body.backupPoints.length).toBeGreaterThanOrEqual(1);

    const listedBp = listRes.body.backupPoints[0];
    expect(listedBp.id).toBeDefined();
    expect(listedBp.status).toBe('completed');
    expect(listedBp.createdAt).toBeDefined();
    expect(listedBp.objectCounts).toBeDefined();
    // objectCounts must include workflow count from mocked enumeration (2 workflows)
    expect(listedBp.objectCounts.workflows).toBe(2);
    // Custom field definitions: 4 fields total (3 system + 1 custom filtered to 1 context)
    expect(listedBp.objectCounts.customFieldDefinitions).toBeGreaterThanOrEqual(1);

    // --- Step 4: Simulate backups.html job-poll to confirm job is completed ---
    const jobPollRes = await request(app)
      .get(`/api/connections/${conn.id}/backup/${jobId}`);
    expect(jobPollRes.status).toBe(200);
    expect(jobPollRes.body.status).toBe('completed');
    expect(jobPollRes.body.integrationId).toBe(conn.id);

    // Verify the internal db job record links the job to the listed backup point
    const dbJob = db.backupJobs.get(jobId);
    expect(dbJob.backupPointId).toBe(listedBp.id);

    console.log(
      `[TC-PERSIST-5] PASS — backups.html surface consistent:\n` +
      `  jobId=${jobId}\n` +
      `  backupPointId=${listedBp.id}\n` +
      `  workflows=${listedBp.objectCounts.workflows}\n` +
      `  customFieldDefinitions=${listedBp.objectCounts.customFieldDefinitions}`
    );
  }, 12000);

  test('backups.html: backup point has priorBackupPointId=null for first-ever backup', async () => {
    const conn = seedConnection();
    mockBackupApiCalls();

    const triggerRes = await request(app)
      .post(`/api/connections/${conn.id}/backup`);
    await waitForJob(triggerRes.body.jobId, conn.id);

    const listRes = await request(app)
      .get(`/api/connections/${conn.id}/backups`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.backupPoints.length).toBeGreaterThanOrEqual(1);

    const bp = listRes.body.backupPoints[0];
    // First backup for this connection has no prior point
    expect(bp.priorBackupPointId).toBeNull();
    console.log(`[TC-PERSIST-5b] PASS — first backup priorBackupPointId is null`);
  }, 12000);

  test('backups.html: second backup carries priorBackupPointId from first', async () => {
    const conn = seedConnection();

    // First backup
    mockBackupApiCalls();
    const trigger1 = await request(app).post(`/api/connections/${conn.id}/backup`);
    await waitForJob(trigger1.body.jobId, conn.id);

    const list1 = await request(app).get(`/api/connections/${conn.id}/backups`);
    expect(list1.body.backupPoints.length).toBe(1);
    const firstBpId = list1.body.backupPoints[0].id;

    // Second backup
    jest.clearAllMocks();
    mockBackupApiCalls();
    const trigger2 = await request(app).post(`/api/connections/${conn.id}/backup`);
    await waitForJob(trigger2.body.jobId, conn.id);

    const list2 = await request(app).get(`/api/connections/${conn.id}/backups`);
    expect(list2.body.backupPoints.length).toBe(2);

    // Most recent backup is first (sorted DESC by createdAt)
    const secondBp = list2.body.backupPoints[0];
    expect(secondBp.priorBackupPointId).toBe(firstBpId);

    console.log(
      `[TC-PERSIST-5c] PASS — second backup priorBackupPointId=${secondBp.priorBackupPointId} ` +
      `matches first backup id=${firstBpId}`
    );
  }, 20000);
});
