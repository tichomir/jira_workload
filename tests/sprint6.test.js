'use strict';

/**
 * Sprint 6 — Protected Object Inventory and Resilience Module
 *
 * Test coverage:
 *   - filterPurgeCascadeBasket: mixed basket (allowed + excluded types)
 *   - filterPurgeCascadeBasket: all-excluded basket
 *   - filterPurgeCascadeBasket: all-allowed basket (no exclusions)
 *   - GET /api/v1/resilience/inventory/projects: response shape + purgeProtected: false
 *   - GET /api/v1/resilience/inventory/projects: pagination (page, pageSize)
 *   - GET /api/v1/resilience/inventory/workflows: response shape + purgeProtected: true on all rows
 *   - GET /api/v1/resilience/inventory/workflows: pagination
 *   - GET /api/v1/resilience/inventory/custom-fields: response shape + purgeProtected: true on all rows
 *   - GET /api/v1/resilience/inventory/custom-fields: pagination
 *   - POST /api/v1/resilience/purge/cascade/basket: mixed basket via HTTP
 *   - POST /api/v1/resilience/purge/cascade/basket: all-excluded basket via HTTP
 *   - POST /api/v1/resilience/purge/cascade/basket: invalid request shapes
 */

// ---------------------------------------------------------------------------
// Environment — must precede any require() that loads app modules
// ---------------------------------------------------------------------------
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '0ae79904e41359173d04fe7a63a93c289db8b411b9467cbc87e4d0646e4c133d';
process.env.ATLASSIAN_CLIENT_ID        = '1hCMINKiuGDOyWuGkI4BnMQhq8mwPEa9';
process.env.ATLASSIAN_CLIENT_SECRET    = 'test-secret-sprint6';
process.env.ATLASSIAN_REDIRECT_URI     = 'https://localhost:4443/oauth/callback';
process.env.NODE_ENV                   = 'test';
process.env.FRONTEND_BASE_URL          = 'https://localhost:4443';

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
const { filterPurgeCascadeBasket } = require('../src/services/purgeCascade');

// ---------------------------------------------------------------------------
// Isolation — clear inventory-related DB maps before each test so that
// stub data is consistently used regardless of what prior test files ran.
// ---------------------------------------------------------------------------
beforeEach(() => {
  db.projectNodes.clear();
  db.workflowNodes.clear();
  db.customFieldDefinitions.clear();
  db.customFieldContextNodes.clear();
});

// ---------------------------------------------------------------------------
// Purge cascade guard — unit tests (service layer)
// ---------------------------------------------------------------------------

describe('filterPurgeCascadeBasket — service layer', () => {
  test('mixed basket: excluded types are removed, allowed types pass through', () => {
    const basket = [
      { nodeType: 'JiraIssueNode', targetId: 'issue-1' },
      { nodeType: 'JiraWorkflowNode', targetId: 'wf-1' },
      { nodeType: 'JiraProjectNode', targetId: 'proj-1' },
      { nodeType: 'JiraCustomFieldDefinitionNode', targetId: 'cf-def-1' },
      { nodeType: 'JiraCustomFieldContextNode', targetId: 'cf-ctx-1' },
    ];

    const { allowed, excluded, exclusionLog } = filterPurgeCascadeBasket(basket);

    // Allowed: JiraIssueNode, JiraProjectNode
    expect(allowed).toHaveLength(2);
    expect(allowed.map(a => a.nodeType)).toEqual(
      expect.arrayContaining(['JiraIssueNode', 'JiraProjectNode'])
    );

    // Excluded: JiraWorkflowNode, JiraCustomFieldDefinitionNode, JiraCustomFieldContextNode
    expect(excluded).toHaveLength(3);
    expect(excluded.map(e => e.nodeType)).toEqual(
      expect.arrayContaining([
        'JiraWorkflowNode',
        'JiraCustomFieldDefinitionNode',
        'JiraCustomFieldContextNode',
      ])
    );

    // Exclusion log entries match excluded count
    expect(exclusionLog).toHaveLength(3);
    for (const entry of exclusionLog) {
      expect(entry.event).toBe('PURGE_CASCADE_EXCLUSION');
      expect(entry.nodeType).toBeDefined();
      expect(entry.reason).toBeDefined();
      expect(entry.timestamp).toBeDefined();
    }
  });

  test('all-excluded basket: allowed is empty, all items appear in excluded + exclusionLog', () => {
    const basket = [
      { nodeType: 'JiraWorkflowNode', targetId: 'wf-a' },
      { nodeType: 'JiraCustomFieldDefinitionNode', targetId: 'cf-def-a' },
      { nodeType: 'JiraCustomFieldContextNode', targetId: 'cf-ctx-a' },
    ];

    const { allowed, excluded, exclusionLog } = filterPurgeCascadeBasket(basket);

    expect(allowed).toHaveLength(0);
    expect(excluded).toHaveLength(3);
    expect(exclusionLog).toHaveLength(3);

    for (const entry of exclusionLog) {
      expect(entry.event).toBe('PURGE_CASCADE_EXCLUSION');
    }
  });

  test('all-allowed basket: excluded and exclusionLog are empty', () => {
    const basket = [
      { nodeType: 'JiraIssueNode', targetId: 'issue-1' },
      { nodeType: 'JiraProjectNode', targetId: 'proj-1' },
      { nodeType: 'JiraSprintNode', targetId: 'sprint-1' },
    ];

    const { allowed, excluded, exclusionLog } = filterPurgeCascadeBasket(basket);

    expect(allowed).toHaveLength(3);
    expect(excluded).toHaveLength(0);
    expect(exclusionLog).toHaveLength(0);
  });

  test('targetId is preserved for allowed and excluded items', () => {
    const basket = [
      { nodeType: 'JiraIssueNode', targetId: 'issue-xyz' },
      { nodeType: 'JiraWorkflowNode', targetId: 'wf-xyz' },
    ];

    const { allowed, excluded } = filterPurgeCascadeBasket(basket);

    expect(allowed[0].targetId).toBe('issue-xyz');
    expect(excluded[0].targetId).toBe('wf-xyz');
  });

  test('items without targetId get targetId: null in output', () => {
    const basket = [
      { nodeType: 'JiraWorkflowNode' },
      { nodeType: 'JiraIssueNode' },
    ];

    const { allowed, excluded } = filterPurgeCascadeBasket(basket);

    expect(excluded[0].targetId).toBeNull();
    expect(allowed[0].targetId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/resilience/inventory/projects
// ---------------------------------------------------------------------------

describe('GET /api/v1/resilience/inventory/projects', () => {
  test('returns 200 with correct shape', async () => {
    const res = await request(app).get('/api/v1/resilience/inventory/projects');

    expect(res.status).toBe(200);
    expect(res.body.nodeType).toBe('JiraProjectNode');
    expect(typeof res.body.page).toBe('number');
    expect(typeof res.body.pageSize).toBe('number');
    expect(typeof res.body.total).toBe('number');
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(Array.isArray(res.body.columns)).toBe(true);
  });

  test('purgeProtected is false at the response level', async () => {
    const res = await request(app).get('/api/v1/resilience/inventory/projects');
    expect(res.status).toBe(200);
    expect(res.body.purgeProtected).toBe(false);
  });

  test('all rows have purgeProtected: false', async () => {
    const res = await request(app).get('/api/v1/resilience/inventory/projects');
    expect(res.status).toBe(200);
    for (const row of res.body.items) {
      expect(row.purgeProtected).toBe(false);
    }
  });

  test('rows contain required T8 §3.2 fields', async () => {
    const res = await request(app).get('/api/v1/resilience/inventory/projects');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);

    const row = res.body.items[0];
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('name');
    expect(row).toHaveProperty('cloudSite');
    expect(row).toHaveProperty('projectKey');
    expect(row).toHaveProperty('projectTypeKey');
    expect(typeof row.archived).toBe('boolean');
    expect(typeof row.issueCount).toBe('number');
    expect(typeof row.backupPointCount).toBe('number');
    expect(row).toHaveProperty('lastBackupAt');
  });

  test('columns include expected T8 §3.2 column ids', async () => {
    const res = await request(app).get('/api/v1/resilience/inventory/projects');
    expect(res.status).toBe(200);
    const colIds = res.body.columns.map(c => c.id);
    expect(colIds).toContain('name');
    expect(colIds).toContain('projectKey');
    expect(colIds).toContain('projectTypeKey');
    expect(colIds).toContain('cloudSite');
    expect(colIds).toContain('archived');
    expect(colIds).toContain('issueCount');
    expect(colIds).toContain('backupPointCount');
    expect(colIds).toContain('lastBackupAt');
  });

  test('pagination: pageSize=1 returns exactly 1 item', async () => {
    const res = await request(app)
      .get('/api/v1/resilience/inventory/projects')
      .query({ pageSize: 1, page: 1 });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.pageSize).toBe(1);
    expect(res.body.page).toBe(1);
  });

  test('pagination: page=2 with pageSize=1 returns second item', async () => {
    const page1 = await request(app)
      .get('/api/v1/resilience/inventory/projects')
      .query({ pageSize: 1, page: 1 });
    const page2 = await request(app)
      .get('/api/v1/resilience/inventory/projects')
      .query({ pageSize: 1, page: 2 });

    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);
    expect(page1.body.items[0].id).not.toBe(page2.body.items[0].id);
  });

  test('pagination: page beyond total returns empty items array', async () => {
    const res = await request(app)
      .get('/api/v1/resilience/inventory/projects')
      .query({ pageSize: 100, page: 999 });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/resilience/inventory/workflows
// ---------------------------------------------------------------------------

describe('GET /api/v1/resilience/inventory/workflows', () => {
  test('returns 200 with correct shape', async () => {
    const res = await request(app).get('/api/v1/resilience/inventory/workflows');

    expect(res.status).toBe(200);
    expect(res.body.nodeType).toBe('JiraWorkflowNode');
    expect(typeof res.body.page).toBe('number');
    expect(typeof res.body.pageSize).toBe('number');
    expect(typeof res.body.total).toBe('number');
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(Array.isArray(res.body.columns)).toBe(true);
  });

  test('purgeProtected is true at the response level', async () => {
    const res = await request(app).get('/api/v1/resilience/inventory/workflows');
    expect(res.status).toBe(200);
    expect(res.body.purgeProtected).toBe(true);
  });

  test('all rows have purgeProtected: true', async () => {
    const res = await request(app).get('/api/v1/resilience/inventory/workflows');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const row of res.body.items) {
      expect(row.purgeProtected).toBe(true);
    }
  });

  test('rows contain required T8 §3.3 fields', async () => {
    const res = await request(app).get('/api/v1/resilience/inventory/workflows');
    expect(res.status).toBe(200);
    const row = res.body.items[0];
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('name');
    expect(row).toHaveProperty('cloudSite');
    expect(row).toHaveProperty('workflowId');
    expect(typeof row.stepCount).toBe('number');
    expect(typeof row.isDefault).toBe('boolean');
    expect(row).toHaveProperty('lastBackupAt');
  });

  test('columns include purgeProtectedBadge column', async () => {
    const res = await request(app).get('/api/v1/resilience/inventory/workflows');
    expect(res.status).toBe(200);
    const colIds = res.body.columns.map(c => c.id);
    expect(colIds).toContain('purgeProtectedBadge');
    expect(colIds).toContain('workflowId');
    expect(colIds).toContain('stepCount');
    expect(colIds).toContain('isDefault');
  });

  test('pagination: pageSize=1 returns exactly 1 item', async () => {
    const res = await request(app)
      .get('/api/v1/resilience/inventory/workflows')
      .query({ pageSize: 1, page: 1 });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.pageSize).toBe(1);
  });

  test('pagination: page beyond total returns empty items array', async () => {
    const res = await request(app)
      .get('/api/v1/resilience/inventory/workflows')
      .query({ pageSize: 100, page: 999 });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/resilience/inventory/custom-fields
// ---------------------------------------------------------------------------

describe('GET /api/v1/resilience/inventory/custom-fields', () => {
  test('returns 200 with correct shape', async () => {
    const res = await request(app).get('/api/v1/resilience/inventory/custom-fields');

    expect(res.status).toBe(200);
    expect(res.body.nodeType).toBe('JiraCustomFieldNode');
    expect(typeof res.body.page).toBe('number');
    expect(typeof res.body.pageSize).toBe('number');
    expect(typeof res.body.total).toBe('number');
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(Array.isArray(res.body.columns)).toBe(true);
  });

  test('purgeProtected is true at the response level', async () => {
    const res = await request(app).get('/api/v1/resilience/inventory/custom-fields');
    expect(res.status).toBe(200);
    expect(res.body.purgeProtected).toBe(true);
  });

  test('all rows have purgeProtected: true', async () => {
    const res = await request(app).get('/api/v1/resilience/inventory/custom-fields');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const row of res.body.items) {
      expect(row.purgeProtected).toBe(true);
    }
  });

  test('rows contain required T8 §3.4 fields', async () => {
    const res = await request(app).get('/api/v1/resilience/inventory/custom-fields');
    expect(res.status).toBe(200);
    const row = res.body.items[0];
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('name');
    expect(row).toHaveProperty('cloudSite');
    expect(row).toHaveProperty('fieldId');
    expect(row).toHaveProperty('fieldType');
    expect(typeof row.contextCount).toBe('number');
    expect(row).toHaveProperty('lastBackupAt');
  });

  test('columns include purgeProtectedBadge column', async () => {
    const res = await request(app).get('/api/v1/resilience/inventory/custom-fields');
    expect(res.status).toBe(200);
    const colIds = res.body.columns.map(c => c.id);
    expect(colIds).toContain('purgeProtectedBadge');
    expect(colIds).toContain('fieldId');
    expect(colIds).toContain('fieldType');
    expect(colIds).toContain('contextCount');
  });

  test('pagination: pageSize=1 returns exactly 1 item', async () => {
    const res = await request(app)
      .get('/api/v1/resilience/inventory/custom-fields')
      .query({ pageSize: 1, page: 1 });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.pageSize).toBe(1);
  });

  test('pagination: page=2 with pageSize=1 returns second item', async () => {
    const page1 = await request(app)
      .get('/api/v1/resilience/inventory/custom-fields')
      .query({ pageSize: 1, page: 1 });
    const page2 = await request(app)
      .get('/api/v1/resilience/inventory/custom-fields')
      .query({ pageSize: 1, page: 2 });

    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);
    expect(page1.body.items[0].id).not.toBe(page2.body.items[0].id);
  });

  test('pagination: page beyond total returns empty items array', async () => {
    const res = await request(app)
      .get('/api/v1/resilience/inventory/custom-fields')
      .query({ pageSize: 100, page: 999 });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/resilience/purge/cascade/basket — HTTP endpoint
// ---------------------------------------------------------------------------

describe('POST /api/v1/resilience/purge/cascade/basket', () => {
  test('mixed basket: excluded types removed, allowed types returned, no error', async () => {
    const res = await request(app)
      .post('/api/v1/resilience/purge/cascade/basket')
      .send({
        basket: [
          { nodeType: 'JiraIssueNode', targetId: 'issue-1' },
          { nodeType: 'JiraWorkflowNode', targetId: 'wf-1' },
          { nodeType: 'JiraCustomFieldDefinitionNode', targetId: 'cf-1' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.allowed).toHaveLength(1);
    expect(res.body.allowed[0].nodeType).toBe('JiraIssueNode');
    expect(res.body.excluded).toHaveLength(2);
    expect(res.body.exclusionLog).toHaveLength(2);
    expect(res.body.cascadeAccepted).toBe(true);
    expect(res.body.summary.total).toBe(3);
    expect(res.body.summary.allowedCount).toBe(1);
    expect(res.body.summary.excludedCount).toBe(2);
  });

  test('all-excluded basket: allowed is empty, cascadeAccepted is false', async () => {
    const res = await request(app)
      .post('/api/v1/resilience/purge/cascade/basket')
      .send({
        basket: [
          { nodeType: 'JiraWorkflowNode', targetId: 'wf-a' },
          { nodeType: 'JiraCustomFieldDefinitionNode', targetId: 'cf-a' },
          { nodeType: 'JiraCustomFieldContextNode', targetId: 'ctx-a' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.allowed).toHaveLength(0);
    expect(res.body.excluded).toHaveLength(3);
    expect(res.body.exclusionLog).toHaveLength(3);
    expect(res.body.cascadeAccepted).toBe(false);
  });

  test('exclusion log entries have required fields', async () => {
    const res = await request(app)
      .post('/api/v1/resilience/purge/cascade/basket')
      .send({
        basket: [{ nodeType: 'JiraWorkflowNode', targetId: 'wf-1' }],
      });

    expect(res.status).toBe(200);
    const entry = res.body.exclusionLog[0];
    expect(entry.event).toBe('PURGE_CASCADE_EXCLUSION');
    expect(entry.nodeType).toBe('JiraWorkflowNode');
    expect(entry.targetId).toBe('wf-1');
    expect(entry.reason).toBeDefined();
    expect(entry.timestamp).toBeDefined();
  });

  test('missing basket field returns 400', async () => {
    const res = await request(app)
      .post('/api/v1/resilience/purge/cascade/basket')
      .send({ nodeType: 'JiraIssueNode' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_BASKET');
  });

  test('empty basket array returns 400', async () => {
    const res = await request(app)
      .post('/api/v1/resilience/purge/cascade/basket')
      .send({ basket: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('EMPTY_BASKET');
  });
});
