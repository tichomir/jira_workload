'use strict';

/**
 * Sprint — Object Explorer /api/explorer/objects Tests
 *
 * Covers:
 *   AC-1  GET /api/explorer/objects?backupPointId=X&connectionId=Y returns 200 with non-empty
 *         objects for a backup that has backed-up objects
 *   AC-2  Response includes all four object types: issues, projects, workflows, customFields
 *         with correct counts
 *   AC-3  Endpoint returns 200 with empty arrays when a valid backupPointId has no objects
 *         of a given type
 *   AC-4  Storage key used by backup engine (objectSnapshots) matches what this endpoint reads
 *   AC-5  GET /api/v1/backup-points/:id/objects returns correct results after manifests are
 *         written by the backup engine (Object Explorer diff path)
 */

// ---------------------------------------------------------------------------
// Environment setup
// ---------------------------------------------------------------------------
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '0ae79904e41359173d04fe7a63a93c289db8b411b9467cbc87e4d0646e4c133d';
process.env.ATLASSIAN_CLIENT_ID        = 'test-client-id-explorer';
process.env.ATLASSIAN_CLIENT_SECRET    = 'test-client-secret-explorer';
process.env.ATLASSIAN_REDIRECT_URI     = 'https://localhost:4443/oauth/callback';
process.env.NODE_ENV                   = 'test';

jest.mock('axios');

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

let app;
let db;
let saveManifest;
let computeContentHash;

beforeAll(() => {
  jest.resetModules();
  app = require('../src/app');
  db  = require('../src/db');
  ({ saveManifest, computeContentHash } = require('../src/services/objectExplorerService'));
});

afterEach(() => {
  db.backupPoints.clear();
  db.objectSnapshots.clear();
  db.backupManifests.clear();
  db.searchIssues.clear();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedBackupPoint(overrides = {}) {
  const id = uuidv4();
  const connId = overrides.integrationId || uuidv4();
  db.backupPoints.set(id, {
    id,
    integrationId: connId,
    createdAt: new Date().toISOString(),
    status: 'completed',
    ...overrides,
  });
  return { backupPointId: id, connectionId: connId };
}

function seedSnapshots(backupPointId, counts) {
  const { issues = 0, projects = 0, workflows = 0, customFields = 0 } = counts;

  const issueEntries = [];
  for (let i = 1; i <= issues; i++) {
    const id = `issue-${i}`;
    db.objectSnapshots.set(`${backupPointId}:JiraIssueNode:${id}`, {
      backupPointId, nodeType: 'JiraIssueNode', id, fields: { summary: `Issue ${i}` },
    });
    issueEntries.push({ id, contentHash: computeContentHash({ summary: `Issue ${i}` }) });
  }
  if (issues > 0) saveManifest(backupPointId, 'JiraIssueNode', issueEntries);

  const projectEntries = [];
  for (let i = 1; i <= projects; i++) {
    const id = `project-${i}`;
    db.objectSnapshots.set(`${backupPointId}:JiraProjectNode:${id}`, {
      backupPointId, nodeType: 'JiraProjectNode', id, fields: { name: `Project ${i}` },
    });
    projectEntries.push({ id, contentHash: computeContentHash({ name: `Project ${i}` }) });
  }
  if (projects > 0) saveManifest(backupPointId, 'JiraProjectNode', projectEntries);

  const wfEntries = [];
  for (let i = 1; i <= workflows; i++) {
    const id = `wf-${i}`;
    db.objectSnapshots.set(`${backupPointId}:JiraWorkflowNode:${id}`, {
      backupPointId, nodeType: 'JiraWorkflowNode', id, fields: { name: `Workflow ${i}` },
    });
    wfEntries.push({ id, contentHash: computeContentHash({ name: `Workflow ${i}` }) });
  }
  if (workflows > 0) saveManifest(backupPointId, 'JiraWorkflowNode', wfEntries);

  const cfEntries = [];
  for (let i = 1; i <= customFields; i++) {
    const id = `cf-${i}`;
    db.objectSnapshots.set(`${backupPointId}:JiraCustomFieldDefinitionNode:${id}`, {
      backupPointId, nodeType: 'JiraCustomFieldDefinitionNode', id, fields: { name: `CF ${i}` },
    });
    cfEntries.push({ id, contentHash: computeContentHash({ name: `CF ${i}` }) });
  }
  if (customFields > 0) saveManifest(backupPointId, 'JiraCustomFieldDefinitionNode', cfEntries);
}

// ---------------------------------------------------------------------------
// AC-1: GET /api/explorer/objects returns 200 with non-empty data
// ---------------------------------------------------------------------------
describe('AC-1 — non-empty response for backup with objects', () => {
  test('returns 200 with backupPointId and connectionId', async () => {
    const { backupPointId, connectionId } = seedBackupPoint();
    seedSnapshots(backupPointId, { issues: 3, projects: 1, workflows: 3, customFields: 56 });

    const res = await request(app)
      .get(`/api/explorer/objects?backupPointId=${backupPointId}&connectionId=${connectionId}`);

    expect(res.status).toBe(200);
    expect(res.body.backupPointId).toBe(backupPointId);
    expect(res.body.connectionId).toBe(connectionId);
  });
});

// ---------------------------------------------------------------------------
// AC-2: Response includes all four object types with correct counts
// ---------------------------------------------------------------------------
describe('AC-2 — all four object types with correct counts', () => {
  test('returns issues: 3, projects: 1, workflows: 3, customFields: 56', async () => {
    const { backupPointId, connectionId } = seedBackupPoint();
    seedSnapshots(backupPointId, { issues: 3, projects: 1, workflows: 3, customFields: 56 });

    const res = await request(app)
      .get(`/api/explorer/objects?backupPointId=${backupPointId}&connectionId=${connectionId}`);

    expect(res.status).toBe(200);
    expect(res.body.issues.count).toBe(3);
    expect(res.body.issues.items).toHaveLength(3);
    expect(res.body.projects.count).toBe(1);
    expect(res.body.projects.items).toHaveLength(1);
    expect(res.body.workflows.count).toBe(3);
    expect(res.body.workflows.items).toHaveLength(3);
    expect(res.body.customFields.count).toBe(56);
    expect(res.body.customFields.items).toHaveLength(56);
  });

  test('items include id and fields', async () => {
    const { backupPointId, connectionId } = seedBackupPoint();
    seedSnapshots(backupPointId, { issues: 1, projects: 0, workflows: 0, customFields: 0 });

    const res = await request(app)
      .get(`/api/explorer/objects?backupPointId=${backupPointId}&connectionId=${connectionId}`);

    expect(res.status).toBe(200);
    expect(res.body.issues.items[0]).toMatchObject({
      id: 'issue-1',
      nodeType: 'JiraIssueNode',
      fields: { summary: 'Issue 1' },
    });
  });
});

// ---------------------------------------------------------------------------
// AC-3: 200 with empty arrays when a type has no objects
// ---------------------------------------------------------------------------
describe('AC-3 — 200 with empty arrays for types with no objects', () => {
  test('backup with only issues: projects, workflows, customFields are empty arrays', async () => {
    const { backupPointId, connectionId } = seedBackupPoint();
    seedSnapshots(backupPointId, { issues: 2, projects: 0, workflows: 0, customFields: 0 });

    const res = await request(app)
      .get(`/api/explorer/objects?backupPointId=${backupPointId}&connectionId=${connectionId}`);

    expect(res.status).toBe(200);
    expect(res.body.issues.count).toBe(2);
    expect(res.body.projects.count).toBe(0);
    expect(res.body.projects.items).toEqual([]);
    expect(res.body.workflows.count).toBe(0);
    expect(res.body.workflows.items).toEqual([]);
    expect(res.body.customFields.count).toBe(0);
    expect(res.body.customFields.items).toEqual([]);
  });

  test('backup with no objects at all returns all empty', async () => {
    const { backupPointId } = seedBackupPoint();

    const res = await request(app)
      .get(`/api/explorer/objects?backupPointId=${backupPointId}`);

    expect(res.status).toBe(200);
    expect(res.body.issues.count).toBe(0);
    expect(res.body.projects.count).toBe(0);
    expect(res.body.workflows.count).toBe(0);
    expect(res.body.customFields.count).toBe(0);
  });

  test('404 for missing backupPointId', async () => {
    const res = await request(app)
      .get('/api/explorer/objects?backupPointId=nonexistent-id');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('BACKUP_POINT_NOT_FOUND');
  });

  test('400 when backupPointId not provided', async () => {
    const res = await request(app).get('/api/explorer/objects');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_BACKUP_POINT_ID');
  });
});

// ---------------------------------------------------------------------------
// AC-4: Storage key alignment — backupEngine writes, explorer reads same keys
// ---------------------------------------------------------------------------
describe('AC-4 — storage key alignment between backup engine write and explorer read', () => {
  test('objectSnapshots key format matches what explorer scans', async () => {
    const { backupPointId } = seedBackupPoint();

    // Write using exact same key format the backup engine uses
    const issueId = 'TS-1';
    db.objectSnapshots.set(`${backupPointId}:JiraIssueNode:${issueId}`, {
      backupPointId,
      nodeType: 'JiraIssueNode',
      id: issueId,
      fields: { summary: 'Test Issue', status: { name: 'To Do' } },
    });

    const res = await request(app)
      .get(`/api/explorer/objects?backupPointId=${backupPointId}`);

    expect(res.status).toBe(200);
    expect(res.body.issues.count).toBe(1);
    expect(res.body.issues.items[0].id).toBe(issueId);
  });
});

// ---------------------------------------------------------------------------
// AC-5: Object Explorer diff path works after manifests are written
// ---------------------------------------------------------------------------
describe('AC-5 — Object Explorer diff endpoint returns non-empty results with manifests', () => {
  test('GET /api/v1/backup-points/:id/objects?nodeType=JiraIssueNode returns issues', async () => {
    const { backupPointId } = seedBackupPoint();
    seedSnapshots(backupPointId, { issues: 3 });

    const res = await request(app)
      .get(`/api/v1/backup-points/${backupPointId}/objects?nodeType=JiraIssueNode&showUnchanged=true`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.results).toHaveLength(3);
  });

  test('GET /api/v1/backup-points/:id/objects?nodeType=JiraProjectNode returns projects', async () => {
    const { backupPointId } = seedBackupPoint();
    seedSnapshots(backupPointId, { projects: 1 });

    const res = await request(app)
      .get(`/api/v1/backup-points/${backupPointId}/objects?nodeType=JiraProjectNode&showUnchanged=true`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.results).toHaveLength(1);
  });

  test('GET /api/v1/backup-points/:id/objects?nodeType=JiraWorkflowNode returns workflows', async () => {
    const { backupPointId } = seedBackupPoint();
    seedSnapshots(backupPointId, { workflows: 3 });

    const res = await request(app)
      .get(`/api/v1/backup-points/${backupPointId}/objects?nodeType=JiraWorkflowNode&showUnchanged=true`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
  });

  test('GET /api/v1/backup-points/:id/objects?nodeType=JiraCustomFieldDefinitionNode returns custom fields', async () => {
    const { backupPointId } = seedBackupPoint();
    seedSnapshots(backupPointId, { customFields: 56 });

    const res = await request(app)
      .get(`/api/v1/backup-points/${backupPointId}/objects?nodeType=JiraCustomFieldDefinitionNode&showUnchanged=true`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(56);
  });
});
