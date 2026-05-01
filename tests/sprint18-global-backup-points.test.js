'use strict';

/**
 * Sprint 18 — Global Backup Points Endpoint Tests
 *
 * Covers:
 *   AC-1  GET /api/v1/backup-points returns paginated list with backupPointId, jobId,
 *         integrationId, startedAt, completedAt, status, objectCounts
 *   AC-2  GET /api/backups (alias) returns the same data
 *   AC-3  connectionId filter narrows results
 *   AC-4  cursor-based pagination works correctly
 *   AC-5  backupPointId in job poll response is full UUID (not truncated)
 */

// ---------------------------------------------------------------------------
// Environment setup
// ---------------------------------------------------------------------------
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '0ae79904e41359173d04fe7a63a93c289db8b411b9467cbc87e4d0646e4c133d';
process.env.ATLASSIAN_CLIENT_ID        = 'test-client-id-sprint18';
process.env.ATLASSIAN_CLIENT_SECRET    = 'test-client-secret-sprint18';
process.env.ATLASSIAN_REDIRECT_URI     = 'https://localhost:4443/oauth/callback';
process.env.NODE_ENV                   = 'test';

jest.mock('axios');

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

let app;
let db;

beforeAll(() => {
  jest.resetModules();
  app = require('../src/app');
  db  = require('../src/db');
});

beforeEach(() => {
  // Ensure clean state before each test (guards against cross-suite db pollution)
  db.connections.clear();
  db.backupPoints.clear();
  db.backupJobs.clear();
});

afterEach(() => {
  // Clean up test data after each test
  db.connections.clear();
  db.backupPoints.clear();
  db.backupJobs.clear();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedConnection(overrides = {}) {
  const id = uuidv4();
  db.connections.set(id, {
    id,
    status: 'active',
    cloudId: 'test-cloud-id',
    siteName: 'mysite.atlassian.net',
    siteUrl: 'https://mysite.atlassian.net',
    cloudIdVerifiedAt: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

function seedBackupPoint(integrationId, overrides = {}) {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.backupPoints.set(id, {
    id,
    integrationId,
    createdAt: now,
    priorBackupPointId: null,
    status: 'completed',
    objectCounts: { issues: 5, projects: 1, workflows: 2, customFields: 3, boards: 0, sprints: 0, attachments: 0 },
    ...overrides,
  });
  return id;
}

function seedBackupJob(integrationId, backupPointId, overrides = {}) {
  const jobId = uuidv4();
  const now = new Date().toISOString();
  db.backupJobs.set(jobId, {
    id: jobId,
    integrationId,
    backupPointId,
    status: 'completed',
    triggeredAt: now,
    completedAt: now,
    error: null,
    ...overrides,
  });
  return jobId;
}

// ---------------------------------------------------------------------------
// AC-1: GET /api/v1/backup-points returns expected fields
// ---------------------------------------------------------------------------
describe('GET /api/v1/backup-points', () => {
  test('returns empty list when no backup points exist', async () => {
    const res = await request(app).get('/api/v1/backup-points');
    expect(res.status).toBe(200);
    expect(res.body.backupPoints).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.nextCursor).toBeNull();
  });

  test('returns backup point with all required fields', async () => {
    const integrationId = seedConnection();
    const bpId = seedBackupPoint(integrationId);
    const jobId = seedBackupJob(integrationId, bpId);

    const res = await request(app).get('/api/v1/backup-points');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const bp = res.body.backupPoints[0];

    // AC-1: all required fields present
    expect(bp.backupPointId).toBe(bpId);
    expect(bp.id).toBe(bpId);
    expect(bp.jobId).toBe(jobId);
    expect(bp.integrationId).toBe(integrationId);
    expect(bp.startedAt).toBeTruthy();
    expect(bp.completedAt).toBeTruthy();
    expect(bp.status).toBe('completed');
    expect(bp.objectCounts).toBeTruthy();
    expect(bp.objectCounts.issues).toBe(5);
    expect(bp.siteName).toBe('mysite.atlassian.net');
  });

  test('backupPointId is a full UUID (not truncated)', async () => {
    const integrationId = seedConnection();
    const bpId = seedBackupPoint(integrationId);
    seedBackupJob(integrationId, bpId);

    const res = await request(app).get('/api/v1/backup-points');
    const bp = res.body.backupPoints[0];
    // UUID format: 8-4-4-4-12 hex chars
    expect(bp.backupPointId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('returns multiple backup points sorted newest first', async () => {
    const integrationId = seedConnection();
    const bp1 = seedBackupPoint(integrationId, { createdAt: '2026-05-01T10:00:00.000Z' });
    const bp2 = seedBackupPoint(integrationId, { createdAt: '2026-05-01T12:00:00.000Z' });
    seedBackupJob(integrationId, bp1);
    seedBackupJob(integrationId, bp2);

    const res = await request(app).get('/api/v1/backup-points');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    // Newest first
    expect(res.body.backupPoints[0].backupPointId).toBe(bp2);
    expect(res.body.backupPoints[1].backupPointId).toBe(bp1);
  });
});

// ---------------------------------------------------------------------------
// AC-2: GET /api/backups alias
// ---------------------------------------------------------------------------
describe('GET /api/backups', () => {
  test('alias returns same data as /api/v1/backup-points', async () => {
    const integrationId = seedConnection();
    const bpId = seedBackupPoint(integrationId);
    seedBackupJob(integrationId, bpId);

    const res = await request(app).get('/api/backups');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.backupPoints[0].backupPointId).toBe(bpId);
  });
});

// ---------------------------------------------------------------------------
// AC-3: connectionId filter
// ---------------------------------------------------------------------------
describe('GET /api/v1/backup-points?connectionId=...', () => {
  test('filters results to specified connection', async () => {
    const connA = seedConnection({ siteName: 'site-a.atlassian.net' });
    const connB = seedConnection({ siteName: 'site-b.atlassian.net' });
    const bpA = seedBackupPoint(connA);
    const bpB = seedBackupPoint(connB);
    seedBackupJob(connA, bpA);
    seedBackupJob(connB, bpB);

    const res = await request(app).get(`/api/v1/backup-points?connectionId=${connA}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.backupPoints[0].backupPointId).toBe(bpA);
    expect(res.body.backupPoints[0].integrationId).toBe(connA);
  });
});

// ---------------------------------------------------------------------------
// AC-4: cursor-based pagination
// ---------------------------------------------------------------------------
describe('GET /api/v1/backup-points pagination', () => {
  test('returns paginated results with nextCursor', async () => {
    const integrationId = seedConnection();
    // Seed 3 backup points with distinct timestamps
    const bps = [];
    for (let i = 0; i < 3; i++) {
      const ts = `2026-05-01T${String(10 + i).padStart(2, '0')}:00:00.000Z`;
      const bpId = seedBackupPoint(integrationId, { createdAt: ts });
      seedBackupJob(integrationId, bpId);
      bps.push(bpId);
    }

    // Fetch first page of 2
    const res1 = await request(app).get('/api/v1/backup-points?limit=2');
    expect(res1.status).toBe(200);
    expect(res1.body.backupPoints).toHaveLength(2);
    expect(res1.body.total).toBe(3);
    expect(res1.body.nextCursor).toBeTruthy();

    // Fetch second page using cursor
    const res2 = await request(app).get(`/api/v1/backup-points?limit=2&cursor=${res1.body.nextCursor}`);
    expect(res2.status).toBe(200);
    expect(res2.body.backupPoints).toHaveLength(1);
    expect(res2.body.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-5: job poll includes full backupPointId
// ---------------------------------------------------------------------------
describe('GET /api/v1/integrations/:id/backup/:jobId poll', () => {
  test('completed job poll returns full backupPointId UUID', async () => {
    const integrationId = seedConnection();
    const bpId = seedBackupPoint(integrationId);
    const jobId = seedBackupJob(integrationId, bpId);

    const res = await request(app).get(`/api/v1/integrations/${integrationId}/backup/${jobId}`);
    expect(res.status).toBe(200);
    expect(res.body.backupPointId).toBe(bpId);
    // Full UUID format
    expect(res.body.backupPointId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(res.body.jobId).toBe(jobId);
  });
});

// ---------------------------------------------------------------------------
// AC: Backups List accessible from main nav (HTML page tests)
// ---------------------------------------------------------------------------
describe('HTML pages — nav and page accessibility', () => {
  test('GET /all-backups.html returns 200 and is an HTML page', async () => {
    const res = await request(app).get('/all-backups.html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  test('GET /all-backups.html nav contains direct link not requiring Integrations path', async () => {
    const res = await request(app).get('/all-backups.html');
    expect(res.status).toBe(200);
    // The page itself must have a nav link to /all-backups.html (accessible from nav, not via Integrations)
    expect(res.text).toContain('/all-backups.html');
    // Should NOT require /connections.html as the only path to this page
    expect(res.text).toContain('topnav');
  });

  test('GET /index.html has All Backups nav link accessible directly', async () => {
    const res = await request(app).get('/index.html');
    expect(res.status).toBe(200);
    // Home page must link to all-backups.html directly (not through connections/integrations)
    expect(res.text).toContain('/all-backups.html');
  });

  test('GET /browse.html returns 200', async () => {
    const res = await request(app).get('/browse.html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });
});

// ---------------------------------------------------------------------------
// AC: all-backups.html shows full Backup Point ID with copy button
// ---------------------------------------------------------------------------
describe('all-backups.html — Backup Point ID display and copy button', () => {
  test('page contains copy-btn element for copying Backup Point ID', async () => {
    const res = await request(app).get('/all-backups.html');
    expect(res.status).toBe(200);
    // The page must have a copy button styled class
    expect(res.text).toContain('copy-btn');
    // The page must have JS function to copy to clipboard
    expect(res.text).toContain('copyToClipboard');
  });

  test('page renders Backup Point ID column in table header', async () => {
    const res = await request(app).get('/all-backups.html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Backup Point ID');
  });

  test('page uses full UUID for copy (not shortId) via copyToClipboard', async () => {
    const res = await request(app).get('/all-backups.html');
    // shortId() truncates for display but copyToClipboard receives the full ID
    // The JS must pass the full `id` variable (not shortId) to copyToClipboard
    expect(res.text).toContain("copyToClipboard('${escHtml(id)}'");
  });
});

// ---------------------------------------------------------------------------
// AC: Browse from list row opens Object Explorer scoped to backupPointId
// ---------------------------------------------------------------------------
describe('all-backups.html — Browse link scoped to backupPointId', () => {
  test('page builds browse URL with backupPointId query parameter', async () => {
    const res = await request(app).get('/all-backups.html');
    expect(res.status).toBe(200);
    // The renderRow function must build: /browse.html?backupPointId=<id>&tab=explorer
    expect(res.text).toContain('browse.html?backupPointId=');
    expect(res.text).toContain('tab=explorer');
  });

  test('browse link uses encodeURIComponent on backupPointId', async () => {
    const res = await request(app).get('/all-backups.html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('encodeURIComponent(id)');
  });

  test('API backupPointId can construct a valid browse URL', async () => {
    const integrationId = seedConnection();
    const bpId = seedBackupPoint(integrationId);
    seedBackupJob(integrationId, bpId);

    const res = await request(app).get('/api/backups');
    expect(res.status).toBe(200);
    const bp = res.body.backupPoints[0];

    // Construct the expected browse URL using backupPointId from API response
    const expectedBrowseUrl = `/browse.html?backupPointId=${encodeURIComponent(bp.backupPointId)}&tab=explorer`;
    // The URL should be a valid path with a full UUID backupPointId
    expect(expectedBrowseUrl).toContain(bp.backupPointId);
    expect(expectedBrowseUrl).toContain('tab=explorer');
    expect(bp.backupPointId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

// ---------------------------------------------------------------------------
// AC: GET /api/backups field completeness verification
// ---------------------------------------------------------------------------
describe('GET /api/backups — complete field shape', () => {
  test('returns all required fields: backupPointId, timestamps, status, objectCounts', async () => {
    const integrationId = seedConnection();
    const bpId = seedBackupPoint(integrationId, {
      objectCounts: { issues: 10, projects: 2, workflows: 1, customFields: 5, boards: 0, sprints: 3, attachments: 0 },
    });
    const jobId = seedBackupJob(integrationId, bpId);

    const res = await request(app).get('/api/backups');
    expect(res.status).toBe(200);

    const bp = res.body.backupPoints[0];
    // backupPointId
    expect(bp.backupPointId).toBe(bpId);
    // timestamps
    expect(bp.startedAt).toBeTruthy();
    expect(bp.completedAt).toBeTruthy();
    expect(bp.createdAt).toBeTruthy();
    // status
    expect(bp.status).toBe('completed');
    // objectCounts
    expect(bp.objectCounts).toBeTruthy();
    expect(bp.objectCounts.issues).toBe(10);
    expect(bp.objectCounts.projects).toBe(2);
    expect(bp.objectCounts.workflows).toBe(1);
    expect(bp.objectCounts.customFields).toBe(5);
    expect(bp.objectCounts.sprints).toBe(3);
    // jobId
    expect(bp.jobId).toBe(jobId);
    // integrationId / siteName
    expect(bp.integrationId).toBe(integrationId);
    expect(bp.siteName).toBeTruthy();
  });

  test('empty state: returns correct empty state shape when no backups exist', async () => {
    const res = await request(app).get('/api/backups');
    expect(res.status).toBe(200);
    expect(res.body.backupPoints).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.nextCursor).toBeNull();
  });
});
