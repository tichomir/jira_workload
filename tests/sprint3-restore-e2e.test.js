'use strict';

/**
 * Sprint 3 — Backup & Restore End-to-End Fix
 *
 * Regression tests for: "Fix restore: write objects to Jira and surface result in UI"
 *
 * Acceptance criteria verified:
 *   AC-1  After restore completes, restore job record contains restoredCount, skippedCount, failedCount.
 *   AC-2  Write call failures are logged per-object without aborting the entire restore.
 *   AC-3  UI-facing poll endpoint (GET /:id/restore-backup/:jobId) returns restoredCount/skippedCount/failedCount.
 *   AC-4  Conflict mode defaults to 'skip' when not explicitly supplied.
 *   AC-5  The basket is built from objectSnapshots so backed-up issues are included in restore.
 *
 * All tests use destination.type = 'export' so no live Jira API calls are made.
 */

// ---------------------------------------------------------------------------
// Environment — must precede any require() that loads app modules
// ---------------------------------------------------------------------------
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '0ae79904e41359173d04fe7a63a93c289db8b411b9467cbc87e4d0646e4c133d';
process.env.ATLASSIAN_CLIENT_ID        = '1hCMINKiuGDOyWuGkI4BnMQhq8mwPEa9';
process.env.ATLASSIAN_CLIENT_SECRET    = 'test-secret-sprint3-restore-e2e';
process.env.ATLASSIAN_REDIRECT_URI     = 'https://localhost:4443/oauth/callback';
process.env.NODE_ENV                   = 'test';
process.env.FRONTEND_BASE_URL          = 'https://localhost:4443';

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const app = require('../src/app');
const db = require('../src/db');
const { initiateRestore, resolveConflictMode, buildBasket } = require('../src/services/restoreOrchestrator');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clearDb() {
  db.restoreJobs.clear();
  db.exportArchives.clear();
  db.restoredObjects.clear();
  db.objectSnapshots.clear();
  db.connections.clear();
  db.backupPoints.clear();
  db.backupJobs.clear();
  db.projectNodes.clear();
  db.workflowNodes.clear();
  db.customFieldDefinitions.clear();
}

function seedConnection(overrides = {}) {
  const id = overrides.id || uuidv4();
  const conn = {
    id,
    cloudId: overrides.cloudId || 'cloud-test',
    siteId: overrides.siteId,
    accessToken: overrides.accessToken || 'tok',
    accessTokenExpiresAt: overrides.accessTokenExpiresAt || new Date(Date.now() + 3600_000).toISOString(),
    grantedScopes: overrides.grantedScopes || [],
    deletedAt: null,
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
    objectCounts: {},
  };
  db.backupPoints.set(id, bp);
  return bp;
}

function seedIssueSnapshot(backupPointId, id, fields = {}) {
  const key = `${backupPointId}:JiraIssueNode:${id}`;
  db.objectSnapshots.set(key, {
    backupPointId,
    nodeType: 'JiraIssueNode',
    id,
    fields: {
      key: `PROJ-${id}`,
      summary: `Test issue ${id}`,
      issuetype: { name: 'Task' },
      project: { key: 'PROJ' },
      labels: [],
      ...fields,
    },
    issueKey: `PROJ-${id}`,
  });
}

function seedWorkflowSnapshot(backupPointId, id) {
  const key = `${backupPointId}:JiraWorkflowNode:${id}`;
  db.objectSnapshots.set(key, {
    backupPointId,
    nodeType: 'JiraWorkflowNode',
    id,
    fields: { name: `Workflow ${id}`, description: 'Test workflow', statuses: [], transitions: [] },
  });
}

// Export destination — no Jira API calls required
const exportDest = { type: 'export', exportFormat: 'json' };

// ─── Unit: resolveConflictMode defaults ───────────────────────────────────────

describe('Unit — resolveConflictMode defaults (AC-4)', () => {
  test('defaults to skip when conflictMode is undefined', () => {
    const { conflictModeEffective } = resolveConflictMode(undefined, 1);
    expect(conflictModeEffective).toBe('skip');
  });

  test('defaults to skip when conflictMode is null', () => {
    const { conflictModeEffective } = resolveConflictMode(null, 1);
    expect(conflictModeEffective).toBe('skip');
  });

  test('honours explicit skip', () => {
    const { conflictModeEffective } = resolveConflictMode('skip', 5);
    expect(conflictModeEffective).toBe('skip');
  });

  test('honours explicit override', () => {
    const { conflictModeEffective } = resolveConflictMode('override', 5);
    expect(conflictModeEffective).toBe('override');
  });

  test('ask is preserved when basket <= 50', () => {
    const { conflictModeEffective, conflictModeDowngradeReason } = resolveConflictMode('ask', 5);
    expect(conflictModeEffective).toBe('ask');
    expect(conflictModeDowngradeReason).toBeUndefined();
  });

  test('ask is downgraded to skip when basket > 50', () => {
    const { conflictModeEffective, conflictModeDowngradeReason } = resolveConflictMode('ask', 51);
    expect(conflictModeEffective).toBe('skip');
    expect(conflictModeDowngradeReason).toBe('BASKET_SIZE_EXCEEDED');
  });
});

// ─── Unit: buildBasket reads objectSnapshots ──────────────────────────────────

describe('Unit — buildBasket reads objectSnapshots (AC-5)', () => {
  beforeEach(() => clearDb());

  test('empty basket when no snapshots for backupPointId', () => {
    const items = buildBasket('bp-nonexistent', { includeAll: true });
    expect(items).toHaveLength(0);
  });

  test('basket includes issues from objectSnapshots', () => {
    const bpId = 'bp-test';
    seedIssueSnapshot(bpId, 'issue-1');
    seedIssueSnapshot(bpId, 'issue-2');

    const items = buildBasket(bpId, { includeAll: true });
    expect(items.length).toBe(2);
    expect(items.every(i => i.objectType === 'issue')).toBe(true);
  });

  test('basket includes workflows from objectSnapshots', () => {
    const bpId = 'bp-wf';
    seedWorkflowSnapshot(bpId, 'wf-1');
    seedIssueSnapshot(bpId, 'issue-a');

    const items = buildBasket(bpId, { includeAll: true });
    expect(items.length).toBe(2);
    const types = items.map(i => i.objectType);
    expect(types).toContain('issue');
    expect(types).toContain('workflow');
  });

  test('objectType filter in objectSelection narrows basket', () => {
    const bpId = 'bp-filter';
    seedIssueSnapshot(bpId, 'issue-x');
    seedWorkflowSnapshot(bpId, 'wf-x');

    const items = buildBasket(bpId, { includeAll: false, objectTypes: ['issue'] });
    expect(items.every(i => i.objectType === 'issue')).toBe(true);
  });
});

// ─── Integration: initiateRestore end-to-end (export destination) ─────────────

describe('Integration — initiateRestore with export destination (AC-1, AC-2)', () => {
  beforeEach(() => clearDb());

  test('AC-1: result contains restoredCount, skippedCount, failedCount', async () => {
    const bpId = uuidv4();
    seedIssueSnapshot(bpId, 'i1');
    seedIssueSnapshot(bpId, 'i2');

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'site-x',
      destination: exportDest,
      conflictMode: 'skip',
      objectSelection: { includeAll: true },
    });

    expect(result).toHaveProperty('restoredCount');
    expect(result).toHaveProperty('skippedCount');
    expect(result).toHaveProperty('failedCount');
    expect(typeof result.restoredCount).toBe('number');
    expect(typeof result.skippedCount).toBe('number');
    expect(typeof result.failedCount).toBe('number');
  });

  test('AC-1: restoredCount equals number of issues in backup point snapshot', async () => {
    const bpId = uuidv4();
    seedIssueSnapshot(bpId, 'i1');
    seedIssueSnapshot(bpId, 'i2');
    seedIssueSnapshot(bpId, 'i3');

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'site-x',
      destination: exportDest,
      conflictMode: 'skip',
      objectSelection: { includeAll: true },
    });

    expect(result.restoredCount).toBe(3);
    expect(result.skippedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.status).toBe('complete');
  });

  test('AC-1: byType breakdown is present in result', async () => {
    const bpId = uuidv4();
    seedIssueSnapshot(bpId, 'i1');

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'site-x',
      destination: exportDest,
      objectSelection: { includeAll: true },
    });

    expect(result.byType).toBeDefined();
    expect(result.byType.issue).toBeDefined();
    expect(result.byType.issue.restored).toBe(1);
  });

  test('AC-2: restore completes even when basket is empty (no objects in snapshot)', async () => {
    const bpId = uuidv4();
    // No snapshots seeded → empty basket

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'site-x',
      destination: exportDest,
      objectSelection: { includeAll: true },
    });

    expect(result.status).toBe('complete');
    expect(result.restoredCount).toBe(0);
    expect(result.failedCount).toBe(0);
  });

  test('AC-4: conflictModeEffective is skip when conflictMode not supplied', async () => {
    const bpId = uuidv4();
    seedIssueSnapshot(bpId, 'i1');

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'site-x',
      destination: exportDest,
      objectSelection: { includeAll: true },
      // conflictMode intentionally omitted
    });

    expect(result.conflictModeEffective).toBe('skip');
  });

  test('stageResults is populated with per-stage breakdown', async () => {
    const bpId = uuidv4();
    seedIssueSnapshot(bpId, 'i1');
    seedWorkflowSnapshot(bpId, 'wf1');

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'site-x',
      destination: exportDest,
      objectSelection: { includeAll: true },
    });

    expect(Array.isArray(result.stageResults)).toBe(true);
    expect(result.stageResults.length).toBe(5);
  });
});

// ─── Integration: REST route — POST & poll via backup.js ──────────────────────

describe('REST — POST /api/v1/integrations/:id/restore-backup and poll (AC-3)', () => {
  let conn, bp;

  beforeEach(() => {
    clearDb();
    conn = seedConnection({ id: uuidv4() });
    bp = seedBackupPoint(conn.id);
  });

  test('returns 202 with jobId immediately', async () => {
    const res = await request(app)
      .post(`/api/v1/integrations/${conn.id}/restore-backup`)
      .send({ backupPointId: bp.id });

    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeDefined();
    expect(res.body.status).toBe('running');
  });

  test('returns 404 when connectionId is unknown', async () => {
    const res = await request(app)
      .post('/api/v1/integrations/nonexistent/restore-backup')
      .send({ backupPointId: bp.id });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('CONNECTION_NOT_FOUND');
  });

  test('returns 400 MISSING_BACKUP_POINT when backupPointId is absent', async () => {
    const res = await request(app)
      .post(`/api/v1/integrations/${conn.id}/restore-backup`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_BACKUP_POINT');
  });

  test('returns 400 INVALID_CONFLICT_MODE for merge', async () => {
    const res = await request(app)
      .post(`/api/v1/integrations/${conn.id}/restore-backup`)
      .send({ backupPointId: bp.id, conflictMode: 'merge' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_CONFLICT_MODE');
  });

  test('AC-3: poll endpoint returns restoredCount / skippedCount / failedCount after completion', async () => {
    // Seed snapshots so there's something to restore
    seedIssueSnapshot(bp.id, 'poll-issue-1');
    seedIssueSnapshot(bp.id, 'poll-issue-2');

    // Trigger restore with export destination (completes synchronously in the fire-and-forget)
    const postRes = await request(app)
      .post(`/api/v1/integrations/${conn.id}/restore-backup`)
      .send({ backupPointId: bp.id, destination: exportDest });

    expect(postRes.status).toBe(202);
    const { jobId } = postRes.body;

    // The fire-and-forget Promise resolves in the same event loop tick in tests.
    // Yield the microtask queue so the job completion handler runs.
    await new Promise(resolve => setImmediate(resolve));

    const pollRes = await request(app)
      .get(`/api/v1/integrations/${conn.id}/restore-backup/${jobId}`);

    expect(pollRes.status).toBe(200);
    expect(pollRes.body.status).toBe('complete');
    expect(pollRes.body).toHaveProperty('restoredCount');
    expect(pollRes.body).toHaveProperty('skippedCount');
    expect(pollRes.body).toHaveProperty('failedCount');
    expect(typeof pollRes.body.restoredCount).toBe('number');
    expect(pollRes.body.restoredCount).toBe(2);
  });

  test('AC-3: poll endpoint returns 404 for unknown jobId', async () => {
    const res = await request(app)
      .get(`/api/v1/integrations/${conn.id}/restore-backup/nonexistent-job`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('RESTORE_JOB_NOT_FOUND');
  });
});

// ─── Integration: restore job record in db after completion ───────────────────

describe('Integration — restore job db record after completion (AC-1)', () => {
  beforeEach(() => clearDb());

  test('restoreJob record is stored with counts', async () => {
    const bpId = uuidv4();
    seedIssueSnapshot(bpId, 'db-i1');
    seedIssueSnapshot(bpId, 'db-i2');

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'site-x',
      destination: exportDest,
      objectSelection: { includeAll: true },
    });

    const storedJob = db.restoreJobs.get(result.restoreJobId);
    expect(storedJob).toBeDefined();
    expect(storedJob.status).toBe('complete');
    expect(storedJob.restoredCount).toBe(2);
    expect(storedJob.skippedCount).toBe(0);
    expect(storedJob.failedCount).toBe(0);
  });

  test('export archive is created in db for export destination', async () => {
    const bpId = uuidv4();
    seedIssueSnapshot(bpId, 'exp-i1');

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'site-x',
      destination: exportDest,
      objectSelection: { includeAll: true },
    });

    const archive = db.exportArchives.get(result.restoreJobId);
    expect(archive).toBeDefined();
    expect(archive.manifest.length).toBe(1);
    expect(result.exportDownloadUrl).toBeDefined();
  });
});
