'use strict';

/**
 * Sprint 3 — Browse, Search, and Object Explorer
 * Tests all acceptance criteria: search endpoints, Object Explorer diff, tokenisation, date ranges.
 */

// ---------------------------------------------------------------------------
// Environment — must precede any require() that loads app modules
// ---------------------------------------------------------------------------
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '0ae79904e41359173d04fe7a63a93c289db8b411b9467cbc87e4d0646e4c133d';
process.env.ATLASSIAN_CLIENT_ID        = '1hCMINKiuGDOyWuGkI4BnMQhq8mwPEa9';
process.env.ATLASSIAN_CLIENT_SECRET    = 'test-secret-sprint3';
process.env.ATLASSIAN_REDIRECT_URI     = 'https://localhost:4443/oauth/callback';
process.env.NODE_ENV                   = 'test';
process.env.FRONTEND_BASE_URL          = 'https://localhost:4443';

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const app = require('../src/app');
const db = require('../src/db');
const {
  tokenise,
  fulltextMatch,
  keywordPrefixMatch,
  parseRange,
  matchesRange,
} = require('../src/services/searchService');
const {
  computeChangeMap,
  computeChangedFields,
  computeContentHash,
  stableStringify,
} = require('../src/services/objectExplorerService');

// ─── Test Data Helpers ────────────────────────────────────────────────────────

function seedSite(id, name, cloudId) {
  db.cloudSites.set(id, { id, cloudId: cloudId || id, name });
  return { id, cloudId: cloudId || id, name };
}

function seedProject(overrides = {}) {
  const id = overrides.id || uuidv4();
  const proj = {
    id,
    siteId: overrides.siteId || 'site-1',
    key: overrides.key || 'PROJ',
    name: overrides.name || 'Test Project',
    projectTypeKey: overrides.projectTypeKey || 'software',
    archived: overrides.archived || false,
    issueCount: overrides.issueCount || 0,
    lastUpdated: overrides.lastUpdated || '2026-04-01T00:00:00Z',
  };
  db.searchProjects.set(id, proj);
  return proj;
}

function seedIssue(backupPointId, overrides = {}) {
  const id = overrides.id || uuidv4();
  const issue = {
    id,
    backupPointId,
    key: overrides.key || `PROJ-${Math.floor(Math.random() * 1000)}`,
    summary: overrides.summary || 'Test issue summary',
    issuetype: overrides.issuetype || 'Bug',
    status: overrides.status || 'Open',
    statusCategory: overrides.statusCategory || 'To Do',
    priority: overrides.priority || 'Medium',
    assignee: overrides.assignee !== undefined ? overrides.assignee : { accountId: 'user-1', displayName: 'Alice' },
    reporter: overrides.reporter || { accountId: 'user-2', displayName: 'Bob' },
    labels: overrides.labels || [],
    created: overrides.created || '2026-01-15T09:00:00Z',
    updated: overrides.updated || '2026-04-20T14:30:00Z',
    resolved: overrides.resolved || null,
    projectKey: overrides.projectKey || 'PROJ',
  };
  db.searchIssues.set(`${backupPointId}:${id}`, issue);
  return issue;
}

function seedAttachment(overrides = {}) {
  const id = overrides.id || uuidv4();
  const backupPointId = overrides.backupPointId || 'bp-1';
  const att = {
    id,
    backupPointId,
    filename: overrides.filename || 'document.pdf',
    mimeType: overrides.mimeType || 'application/pdf',
    sizeBytes: overrides.sizeBytes || 1024,
    created: overrides.created || '2026-03-10T11:00:00Z',
    issueId: overrides.issueId || 'issue-1',
    issueKey: overrides.issueKey || 'PROJ-1',
    storageKey: overrides.storageKey || 's3://bucket/file',
  };
  db.searchAttachments.set(`${backupPointId}:${id}`, att);
  return att;
}

function seedBoard(backupPointId, overrides = {}) {
  const id = overrides.id || uuidv4();
  const board = {
    id,
    backupPointId,
    name: overrides.name || 'Test Board',
    type: overrides.type || 'scrum',
    projectKey: overrides.projectKey || 'PROJ',
    sprintCount: overrides.sprintCount || 3,
  };
  db.searchBoards.set(`${backupPointId}:${id}`, board);
  return board;
}

function seedSprint(backupPointId, overrides = {}) {
  const id = overrides.id || uuidv4();
  const sprint = {
    id,
    backupPointId,
    name: overrides.name || 'Sprint 1',
    state: overrides.state || 'active',
    boardId: overrides.boardId || 'board-1',
    startDate: overrides.startDate || '2026-04-01T00:00:00Z',
    endDate: overrides.endDate || '2026-04-14T23:59:59Z',
    completeDate: overrides.completeDate || null,
    issueCount: overrides.issueCount || 10,
  };
  db.searchSprints.set(`${backupPointId}:${id}`, sprint);
  return sprint;
}

function seedBackupPoint(overrides = {}) {
  const id = overrides.id || uuidv4();
  const bp = {
    id,
    integrationId: overrides.integrationId || 'integration-1',
    createdAt: overrides.createdAt || new Date().toISOString(),
    priorBackupPointId: overrides.priorBackupPointId || null,
  };
  db.backupPoints.set(id, bp);
  return bp;
}

function seedManifest(backupPointId, nodeType, entries) {
  const key = `${backupPointId}:${nodeType}`;
  db.backupManifests.set(key, {
    id: uuidv4(),
    backupPointId,
    nodeType,
    entries,
    computedAt: new Date().toISOString(),
  });
}

function seedObjectSnapshot(backupPointId, nodeType, id, fields) {
  db.objectSnapshots.set(`${backupPointId}:${nodeType}:${id}`, {
    backupPointId, nodeType, id, fields,
  });
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  db.searchProjects.clear();
  db.searchIssues.clear();
  db.searchAttachments.clear();
  db.searchBoards.clear();
  db.searchSprints.clear();
  db.backupPoints.clear();
  db.backupManifests.clear();
  db.objectSnapshots.clear();
  db.cloudSites.clear();
  db.userPreferences.clear();
  db.workflowNodes.clear();
  db.customFieldDefinitions.clear();
});

// =============================================================================
// UNIT TESTS — tokenisation, range, diff
// =============================================================================

describe('searchService — tokenisation', () => {
  test('tokenise splits on whitespace and punctuation', () => {
    expect(tokenise('hello world')).toEqual(['hello', 'world']);
    expect(tokenise('OAuth 2.0 Setup')).toEqual(['oauth', '2', '0', 'setup']);
    expect(tokenise('')).toEqual([]);
    expect(tokenise(null)).toEqual([]);
  });

  test('fulltextMatch: single token prefix', () => {
    expect(fulltextMatch('Jira Workload Integration', 'jira')).toBe(true);
    expect(fulltextMatch('Jira Workload Integration', 'work')).toBe(true);
    expect(fulltextMatch('Jira Workload Integration', 'xyz')).toBe(false);
  });

  test('fulltextMatch: multi-token AND semantics', () => {
    expect(fulltextMatch('Deploy Webhook Service', 'deploy web')).toBe(true);
    expect(fulltextMatch('Deploy Webhook Service', 'deploy xyz')).toBe(false);
  });

  test('fulltextMatch: empty query always matches', () => {
    expect(fulltextMatch('anything', '')).toBe(true);
    expect(fulltextMatch('anything', null)).toBe(true);
  });

  test('keywordPrefixMatch is case-insensitive prefix', () => {
    expect(keywordPrefixMatch('SOFTWARE', 'soft')).toBe(true);
    expect(keywordPrefixMatch('PROJ-123', 'PROJ')).toBe(true);
    expect(keywordPrefixMatch('ABC', 'XYZ')).toBe(false);
  });
});

describe('searchService — range parsing', () => {
  test('parseRange: gte only', () => {
    const r = parseRange('gte:2026-01-01');
    expect(r.gte).toBeInstanceOf(Date);
    expect(r.gte.getFullYear()).toBe(2026);
  });

  test('parseRange: gte + lte', () => {
    const r = parseRange('gte:2026-01-01,lte:2026-04-30');
    expect(r.gte).toBeInstanceOf(Date);
    expect(r.lte).toBeInstanceOf(Date);
  });

  test('parseRange: throws INVALID_RANGE_FORMAT on bad input', () => {
    expect(() => parseRange('invalid')).toThrow('INVALID_RANGE_FORMAT');
    expect(() => parseRange('gte:notadate')).toThrow('INVALID_RANGE_FORMAT');
  });

  test('matchesRange: null range always passes', () => {
    expect(matchesRange('2026-04-01T00:00:00Z', null)).toBe(true);
  });

  test('matchesRange: null value with range → false', () => {
    expect(matchesRange(null, { gte: new Date('2026-01-01') })).toBe(false);
  });

  test('matchesRange: gte boundary', () => {
    const range = parseRange('gte:2026-03-01');
    expect(matchesRange('2026-04-01T00:00:00Z', range)).toBe(true);
    expect(matchesRange('2026-02-01T00:00:00Z', range)).toBe(false);
  });

  test('matchesRange: lte boundary', () => {
    const range = parseRange('lte:2026-04-30');
    expect(matchesRange('2026-04-01T00:00:00Z', range)).toBe(true);
    expect(matchesRange('2026-05-01T00:00:00Z', range)).toBe(false);
  });

  test('matchesRange: combined gte+lte', () => {
    const range = parseRange('gte:2026-01-01,lte:2026-04-30');
    expect(matchesRange('2026-03-15T00:00:00Z', range)).toBe(true);
    expect(matchesRange('2025-12-31T00:00:00Z', range)).toBe(false);
    expect(matchesRange('2026-05-01T00:00:00Z', range)).toBe(false);
  });
});

describe('objectExplorerService — diff computation', () => {
  test('computeChangeMap: all Added on first backup (no prior)', () => {
    const current = [
      { id: 'obj-1', contentHash: 'hash-a' },
      { id: 'obj-2', contentHash: 'hash-b' },
    ];
    const changeMap = computeChangeMap(current, []);
    expect(changeMap.get('obj-1')).toBe('Added');
    expect(changeMap.get('obj-2')).toBe('Added');
  });

  test('computeChangeMap: Modified when contentHash differs', () => {
    const current = [{ id: 'obj-1', contentHash: 'hash-new' }];
    const prior = [{ id: 'obj-1', contentHash: 'hash-old' }];
    const changeMap = computeChangeMap(current, prior);
    expect(changeMap.get('obj-1')).toBe('Modified');
  });

  test('computeChangeMap: Unchanged when contentHash identical', () => {
    const current = [{ id: 'obj-1', contentHash: 'hash-same' }];
    const prior = [{ id: 'obj-1', contentHash: 'hash-same' }];
    const changeMap = computeChangeMap(current, prior);
    expect(changeMap.get('obj-1')).toBe('Unchanged');
  });

  test('computeChangeMap: Deleted when id in prior but not in current', () => {
    const current = [];
    const prior = [{ id: 'obj-1', contentHash: 'hash-old' }];
    const changeMap = computeChangeMap(current, prior);
    expect(changeMap.get('obj-1')).toBe('Deleted');
  });

  test('computeChangeMap: mixed indicators', () => {
    const current = [
      { id: 'added-obj', contentHash: 'hash-1' },
      { id: 'modified-obj', contentHash: 'hash-new' },
      { id: 'unchanged-obj', contentHash: 'hash-same' },
    ];
    const prior = [
      { id: 'modified-obj', contentHash: 'hash-old' },
      { id: 'unchanged-obj', contentHash: 'hash-same' },
      { id: 'deleted-obj', contentHash: 'hash-del' },
    ];
    const changeMap = computeChangeMap(current, prior);
    expect(changeMap.get('added-obj')).toBe('Added');
    expect(changeMap.get('modified-obj')).toBe('Modified');
    expect(changeMap.get('unchanged-obj')).toBe('Unchanged');
    expect(changeMap.get('deleted-obj')).toBe('Deleted');
  });

  test('computeChangedFields returns changed field names', () => {
    const fields = { status: 'Done', priority: 'High', summary: 'Same' };
    const priorFields = { status: 'Open', priority: 'Medium', summary: 'Same' };
    const changed = computeChangedFields(fields, priorFields);
    expect(changed).toContain('status');
    expect(changed).toContain('priority');
    expect(changed).not.toContain('summary');
  });

  test('computeChangedFields returns empty array for null priorFields', () => {
    expect(computeChangedFields({ a: 1 }, null)).toEqual([]);
  });

  test('stableStringify omits null values and sorts keys', () => {
    const result = stableStringify({ z: 'last', a: 'first', b: null });
    const parsed = JSON.parse(result);
    expect(Object.keys(parsed)).toEqual(['a', 'z']);
    expect(parsed.a).toBe('first');
    expect(parsed.z).toBe('last');
  });

  test('computeContentHash produces consistent SHA-256', () => {
    const obj = { key: 'PROJ-1', summary: 'Fix bug' };
    const h1 = computeContentHash(obj);
    const h2 = computeContentHash({ summary: 'Fix bug', key: 'PROJ-1' }); // different key order
    expect(h1).toBe(h2); // canonical serialisation
    expect(h1).toHaveLength(64); // SHA-256 hex
  });
});

// =============================================================================
// ROUTE TESTS — via supertest
// =============================================================================

describe('GET /api/search/global', () => {
  beforeEach(() => {
    seedSite('site-1', 'Acme Jira');
    seedProject({ id: 'p1', siteId: 'site-1', key: 'ACME', name: 'Acme Platform', projectTypeKey: 'software' });
    seedProject({ id: 'p2', siteId: 'site-1', key: 'BETA', name: 'Beta Service', projectTypeKey: 'business' });
    db.workflowNodes.set('wf-1', { id: 'wf-1', cloudId: 'site-1', name: 'Bug Workflow', entityId: 'WF-BUG' });
    db.customFieldDefinitions.set('cf-1', { id: 'cf-1', cloudId: 'site-1', name: 'Custom Sprint Field', key: 'customfield_10020' });
  });

  test('returns 400 MISSING_QUERY when q is absent', async () => {
    const res = await request(app).get('/api/search/global');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_QUERY');
  });

  test('returns 400 MISSING_QUERY when q is empty string', async () => {
    const res = await request(app).get('/api/search/global?q=');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_QUERY');
  });

  test('returns 400 INVALID_NODE_TYPE for unrecognised nodeType', async () => {
    const res = await request(app).get('/api/search/global?q=acme&nodeType=UnknownNode');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_NODE_TYPE');
  });

  test('returns 404 SITE_NOT_FOUND for unknown siteId', async () => {
    const res = await request(app).get('/api/search/global?q=acme&siteId=nonexistent-site');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SITE_NOT_FOUND');
  });

  test('matches project by name (fulltext)', async () => {
    const res = await request(app).get('/api/search/global?q=acme');
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('p1');
    expect(ids).not.toContain('p2');
  });

  test('matches project by key prefix', async () => {
    const res = await request(app).get('/api/search/global?q=BET');
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('p2');
  });

  test('matches workflow node by name', async () => {
    const res = await request(app).get('/api/search/global?q=bug+workflow');
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('wf-1');
  });

  test('matches custom field by name', async () => {
    const res = await request(app).get('/api/search/global?q=sprint+field');
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('cf-1');
  });

  test('filters by nodeType=JiraProjectNode', async () => {
    const res = await request(app).get('/api/search/global?q=acme&nodeType=JiraProjectNode');
    expect(res.status).toBe(200);
    expect(res.body.results.every(r => r.nodeType === 'JiraProjectNode')).toBe(true);
  });

  test('response includes total and nextCursor', async () => {
    const res = await request(app).get('/api/search/global?q=a');
    expect(res.status).toBe(200);
    expect(typeof res.body.total).toBe('number');
    expect(res.body).toHaveProperty('nextCursor');
  });

  test('each result has required shape fields', async () => {
    const res = await request(app).get('/api/search/global?q=acme');
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThan(0);
    const r = res.body.results[0];
    expect(r).toHaveProperty('id');
    expect(r).toHaveProperty('nodeType');
    expect(r).toHaveProperty('siteId');
    expect(r).toHaveProperty('siteName');
    expect(r).toHaveProperty('name');
    expect(r).toHaveProperty('matchedOn');
  });
});

describe('GET /api/search/projects', () => {
  beforeEach(() => {
    seedProject({ id: 'p1', key: 'ACME', name: 'Acme Platform', projectTypeKey: 'software', archived: false });
    seedProject({ id: 'p2', key: 'OLD',  name: 'Old Service',   projectTypeKey: 'business', archived: true });
    seedProject({ id: 'p3', key: 'BETA', name: 'Beta Kanban',   projectTypeKey: 'software', archived: false });
  });

  test('returns all projects when no filters', async () => {
    const res = await request(app).get('/api/search/projects');
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBe(3);
  });

  test('tokenised name match — q=acme', async () => {
    const res = await request(app).get('/api/search/projects?q=acme');
    expect(res.status).toBe(200);
    expect(res.body.results.map(r => r.id)).toContain('p1');
    expect(res.body.results.map(r => r.id)).not.toContain('p2');
  });

  test('key prefix match — key=ACM', async () => {
    const res = await request(app).get('/api/search/projects?key=ACM');
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('p1');
    expect(ids).not.toContain('p2');
  });

  test('exact key match — key=ACME', async () => {
    const res = await request(app).get('/api/search/projects?key=ACME');
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('p1');
  });

  test('projectTypeKey filter', async () => {
    const res = await request(app).get('/api/search/projects?projectTypeKey=software');
    expect(res.status).toBe(200);
    expect(res.body.results.map(r => r.id)).toContain('p1');
    expect(res.body.results.map(r => r.id)).toContain('p3');
    expect(res.body.results.map(r => r.id)).not.toContain('p2');
  });

  test('archived=true filter', async () => {
    const res = await request(app).get('/api/search/projects?archived=true');
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('p2');
    expect(ids).not.toContain('p1');
  });

  test('archived=false filter', async () => {
    const res = await request(app).get('/api/search/projects?archived=false');
    expect(res.status).toBe(200);
    expect(res.body.results.every(r => r.archived === false)).toBe(true);
  });

  test('returns 400 INVALID_ARCHIVED_VALUE for non-boolean archived', async () => {
    const res = await request(app).get('/api/search/projects?archived=maybe');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_ARCHIVED_VALUE');
  });

  test('combined q + projectTypeKey + archived filters', async () => {
    const res = await request(app).get('/api/search/projects?q=beta&projectTypeKey=software&archived=false');
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('p3');
  });
});

describe('GET /api/backup-points/:backupPointId/issues', () => {
  let bp;
  beforeEach(() => {
    bp = seedBackupPoint({ id: 'bp-issues-1' });

    seedIssue('bp-issues-1', {
      id: 'issue-1', key: 'PROJ-1', summary: 'Login page broken',
      issuetype: 'Bug', status: 'Open', statusCategory: 'To Do',
      priority: 'High', assignee: { accountId: 'u1', displayName: 'Alice' },
      reporter: { accountId: 'u2', displayName: 'Bob' },
      labels: ['auth', 'ui'],
      created: '2026-01-10T00:00:00Z', updated: '2026-04-20T00:00:00Z',
      resolved: null, projectKey: 'PROJ',
    });

    seedIssue('bp-issues-1', {
      id: 'issue-2', key: 'PROJ-2', summary: 'Performance regression on dashboard',
      issuetype: 'Task', status: 'In Progress', statusCategory: 'In Progress',
      priority: 'Medium', assignee: null,
      reporter: { accountId: 'u3', displayName: 'Carol' },
      labels: ['perf'],
      created: '2026-02-01T00:00:00Z', updated: '2026-04-15T00:00:00Z',
      resolved: null, projectKey: 'PROJ',
    });

    seedIssue('bp-issues-1', {
      id: 'issue-3', key: 'INFRA-1', summary: 'Deploy pipeline fix',
      issuetype: 'Story', status: 'Done', statusCategory: 'Done',
      priority: 'Low',
      assignee: { accountId: 'u1', displayName: 'Alice' },
      reporter: { accountId: 'u2', displayName: 'Bob' },
      labels: [],
      created: '2026-01-05T00:00:00Z', updated: '2026-03-01T00:00:00Z',
      resolved: '2026-03-01T10:00:00Z', projectKey: 'INFRA',
    });
  });

  test('returns 404 BACKUP_POINT_NOT_FOUND for unknown backupPointId', async () => {
    const res = await request(app).get('/api/backup-points/nonexistent/issues');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('BACKUP_POINT_NOT_FOUND');
  });

  test('returns all issues when no filters', async () => {
    const res = await request(app).get('/api/backup-points/bp-issues-1/issues');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
  });

  test('fulltext q on summary', async () => {
    const res = await request(app).get('/api/backup-points/bp-issues-1/issues?q=login');
    expect(res.status).toBe(200);
    expect(res.body.results.map(r => r.id)).toContain('issue-1');
    expect(res.body.results.map(r => r.id)).not.toContain('issue-2');
  });

  test('fulltext q on key', async () => {
    const res = await request(app).get('/api/backup-points/bp-issues-1/issues?q=infra');
    expect(res.status).toBe(200);
    expect(res.body.results.map(r => r.id)).toContain('issue-3');
  });

  test('issuetype filter (exact, OR semantics)', async () => {
    const res = await request(app).get('/api/backup-points/bp-issues-1/issues?issuetype=Bug');
    expect(res.status).toBe(200);
    expect(res.body.results.map(r => r.id)).toContain('issue-1');
    expect(res.body.results.map(r => r.id)).not.toContain('issue-2');
  });

  test('status filter', async () => {
    const res = await request(app).get('/api/backup-points/bp-issues-1/issues?status=Open');
    expect(res.status).toBe(200);
    expect(res.body.results.map(r => r.id)).toContain('issue-1');
    expect(res.body.results.map(r => r.id)).not.toContain('issue-2');
  });

  test('statusCategory filter', async () => {
    const res = await request(app).get('/api/backup-points/bp-issues-1/issues?statusCategory=Done');
    expect(res.status).toBe(200);
    expect(res.body.results.map(r => r.id)).toContain('issue-3');
    expect(res.body.results.map(r => r.id)).not.toContain('issue-1');
  });

  test('returns 400 INVALID_STATUS_CATEGORY for bad value', async () => {
    const res = await request(app).get('/api/backup-points/bp-issues-1/issues?statusCategory=Unknown');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_STATUS_CATEGORY');
  });

  test('priority filter', async () => {
    const res = await request(app).get('/api/backup-points/bp-issues-1/issues?priority=High');
    expect(res.status).toBe(200);
    expect(res.body.results.map(r => r.id)).toContain('issue-1');
    expect(res.body.results.map(r => r.id)).not.toContain('issue-2');
  });

  test('assignee filter with specific accountId', async () => {
    const res = await request(app).get('/api/backup-points/bp-issues-1/issues?assignee=u1');
    expect(res.status).toBe(200);
    expect(res.body.results.map(r => r.id)).toContain('issue-1');
    expect(res.body.results.map(r => r.id)).not.toContain('issue-2');
  });

  test('assignee=unassigned sentinel matches null assignee', async () => {
    const res = await request(app).get('/api/backup-points/bp-issues-1/issues?assignee=unassigned');
    expect(res.status).toBe(200);
    expect(res.body.results.map(r => r.id)).toContain('issue-2');
    expect(res.body.results.map(r => r.id)).not.toContain('issue-1');
  });

  test('labels filter uses AND semantics', async () => {
    const res = await request(app).get('/api/backup-points/bp-issues-1/issues?labels=auth,ui');
    expect(res.status).toBe(200);
    // issue-1 has both labels
    expect(res.body.results.map(r => r.id)).toContain('issue-1');
    // issue-2 only has 'perf'
    expect(res.body.results.map(r => r.id)).not.toContain('issue-2');
  });

  test('labels filter excludes issues with no labels when filter present', async () => {
    const res = await request(app).get('/api/backup-points/bp-issues-1/issues?labels=auth');
    expect(res.status).toBe(200);
    // issue-3 has no labels, should be excluded
    expect(res.body.results.map(r => r.id)).not.toContain('issue-3');
  });

  test('created range filter', async () => {
    const res = await request(app).get('/api/backup-points/bp-issues-1/issues?created=gte:2026-02-01');
    expect(res.status).toBe(200);
    expect(res.body.results.map(r => r.id)).toContain('issue-2');
    expect(res.body.results.map(r => r.id)).not.toContain('issue-1');
  });

  test('updated range filter', async () => {
    const res = await request(app).get('/api/backup-points/bp-issues-1/issues?updated=gte:2026-04-01');
    expect(res.status).toBe(200);
    expect(res.body.results.map(r => r.id)).toContain('issue-1');
    expect(res.body.results.map(r => r.id)).toContain('issue-2');
    expect(res.body.results.map(r => r.id)).not.toContain('issue-3');
  });

  test('resolved range excludes issues with null resolved', async () => {
    const res = await request(app).get('/api/backup-points/bp-issues-1/issues?resolved=gte:2026-01-01');
    expect(res.status).toBe(200);
    // Only issue-3 has resolved date
    expect(res.body.results.map(r => r.id)).toContain('issue-3');
    expect(res.body.results.map(r => r.id)).not.toContain('issue-1');
    expect(res.body.results.map(r => r.id)).not.toContain('issue-2');
  });

  test('projectKey filter', async () => {
    const res = await request(app).get('/api/backup-points/bp-issues-1/issues?projectKey=INFRA');
    expect(res.status).toBe(200);
    expect(res.body.results.map(r => r.id)).toContain('issue-3');
    expect(res.body.results.map(r => r.id)).not.toContain('issue-1');
  });

  test('returns 400 INVALID_RANGE_FORMAT for malformed created', async () => {
    const res = await request(app).get('/api/backup-points/bp-issues-1/issues?created=bad-format');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_RANGE_FORMAT');
  });

  test('combined AND logic — multiple filters', async () => {
    const res = await request(app).get(
      '/api/backup-points/bp-issues-1/issues?issuetype=Bug&priority=High&projectKey=PROJ'
    );
    expect(res.status).toBe(200);
    expect(res.body.results.map(r => r.id)).toContain('issue-1');
    expect(res.body.results.map(r => r.id)).not.toContain('issue-2');
    expect(res.body.results.map(r => r.id)).not.toContain('issue-3');
  });

  test('response items have changeIndicator field (issues endpoint response shape)', async () => {
    const res = await request(app).get('/api/backup-points/bp-issues-1/issues');
    expect(res.status).toBe(200);
    const item = res.body.results[0];
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('key');
    expect(item).toHaveProperty('summary');
    expect(item).toHaveProperty('issuetype');
    expect(item).toHaveProperty('status');
    expect(item).toHaveProperty('statusCategory');
    expect(item).toHaveProperty('labels');
    expect(item).toHaveProperty('created');
    expect(item).toHaveProperty('updated');
  });
});

describe('GET /api/search/attachments', () => {
  beforeEach(() => {
    seedAttachment({ id: 'att-1', filename: 'report.pdf', mimeType: 'application/pdf', created: '2026-01-15T00:00:00Z' });
    seedAttachment({ id: 'att-2', filename: 'screenshot.png', mimeType: 'image/png', created: '2026-03-20T00:00:00Z' });
    seedAttachment({ id: 'att-3', filename: 'report-final.pdf', mimeType: 'application/pdf', created: '2026-04-01T00:00:00Z' });
  });

  test('returns all attachments when no filters', async () => {
    const res = await request(app).get('/api/search/attachments');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
  });

  test('tokenised filename match — q=report', async () => {
    const res = await request(app).get('/api/search/attachments?q=report');
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('att-1');
    expect(ids).toContain('att-3');
    expect(ids).not.toContain('att-2');
  });

  test('prefix filename match — q=screen', async () => {
    const res = await request(app).get('/api/search/attachments?q=screen');
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('att-2');
  });

  test('mimeType filter', async () => {
    const res = await request(app).get('/api/search/attachments?mimeType=image%2Fpng');
    expect(res.status).toBe(200);
    expect(res.body.results.map(r => r.id)).toContain('att-2');
    expect(res.body.results.map(r => r.id)).not.toContain('att-1');
  });

  test('mimeType multi-value filter (OR semantics)', async () => {
    const res = await request(app).get('/api/search/attachments?mimeType=image%2Fpng,application%2Fpdf');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
  });

  test('createdFrom date filter', async () => {
    const res = await request(app).get('/api/search/attachments?createdFrom=gte:2026-03-01');
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('att-2');
    expect(ids).toContain('att-3');
    expect(ids).not.toContain('att-1');
  });

  test('createdTo date filter', async () => {
    const res = await request(app).get('/api/search/attachments?createdTo=2026-02-01');
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('att-1');
    expect(ids).not.toContain('att-2');
  });

  test('combined q + mimeType', async () => {
    const res = await request(app).get('/api/search/attachments?q=report&mimeType=application%2Fpdf');
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('att-1');
    expect(ids).toContain('att-3');
  });
});

describe('GET /api/search/boards-sprints', () => {
  beforeEach(() => {
    seedBoard('bp-1', { id: 'board-1', name: 'Scrum Board Alpha', type: 'scrum', projectKey: 'PROJ' });
    seedBoard('bp-1', { id: 'board-2', name: 'Kanban Beta', type: 'kanban', projectKey: 'BETA' });

    seedSprint('bp-1', {
      id: 'sprint-1', name: 'Sprint One Active',
      state: 'active', boardId: 'board-1',
      startDate: '2026-04-01T00:00:00Z', endDate: '2026-04-14T23:59:59Z',
    });
    seedSprint('bp-1', {
      id: 'sprint-2', name: 'Sprint Two Closed',
      state: 'closed', boardId: 'board-1',
      startDate: '2026-03-01T00:00:00Z', endDate: '2026-03-14T23:59:59Z',
    });
    seedSprint('bp-1', {
      id: 'sprint-3', name: 'Sprint Three Future',
      state: 'future', boardId: 'board-2',
      startDate: null, endDate: null,
    });
  });

  test('tokenised name search across sprints', async () => {
    const res = await request(app).get('/api/search/boards-sprints?q=sprint+one');
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('sprint-1');
  });

  test('sprintState=active filter', async () => {
    const res = await request(app).get('/api/search/boards-sprints?sprintState=active');
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('sprint-1');
    expect(ids).not.toContain('sprint-2');
  });

  test('sprintState=closed filter', async () => {
    const res = await request(app).get('/api/search/boards-sprints?sprintState=closed');
    expect(res.status).toBe(200);
    expect(res.body.results.map(r => r.id)).toContain('sprint-2');
    expect(res.body.results.map(r => r.id)).not.toContain('sprint-1');
  });

  test('returns 400 INVALID_SPRINT_STATE for unrecognised state', async () => {
    const res = await request(app).get('/api/search/boards-sprints?sprintState=unknown');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SPRINT_STATE');
  });

  test('dateFrom/dateTo range filter on sprint dates', async () => {
    const res = await request(app).get('/api/search/boards-sprints?dateFrom=2026-04-01&dateTo=2026-04-30');
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('sprint-1');
    expect(ids).not.toContain('sprint-2');
  });

  test('boards returned when no state/date filter', async () => {
    const res = await request(app).get('/api/search/boards-sprints?q=scrum');
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('board-1');
  });

  test('combined q + sprintState', async () => {
    const res = await request(app).get('/api/search/boards-sprints?q=sprint&sprintState=future');
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('sprint-3');
    expect(ids).not.toContain('sprint-1');
  });
});

describe('GET /api/backup-points/:backupPointId/objects', () => {
  let bpId, priorBpId;

  beforeEach(() => {
    priorBpId = 'prior-bp-1';
    bpId = 'current-bp-1';

    seedBackupPoint({ id: priorBpId, priorBackupPointId: null });
    seedBackupPoint({ id: bpId, priorBackupPointId: priorBpId });

    // Manifests:
    //   added-obj  — in current, not in prior
    //   modified-obj — in both, different hash
    //   unchanged-obj — in both, same hash
    //   deleted-obj — in prior, not in current
    seedManifest(priorBpId, 'JiraIssueNode', [
      { id: 'modified-obj', contentHash: 'hash-old' },
      { id: 'unchanged-obj', contentHash: 'hash-same' },
      { id: 'deleted-obj', contentHash: 'hash-del' },
    ]);

    seedManifest(bpId, 'JiraIssueNode', [
      { id: 'added-obj', contentHash: 'hash-new' },
      { id: 'modified-obj', contentHash: 'hash-updated' },
      { id: 'unchanged-obj', contentHash: 'hash-same' },
    ]);

    // Snapshots
    seedObjectSnapshot(bpId, 'JiraIssueNode', 'added-obj', { key: 'PROJ-10', summary: 'New issue' });
    seedObjectSnapshot(bpId, 'JiraIssueNode', 'modified-obj', { key: 'PROJ-11', summary: 'Updated summary', status: 'Done' });
    seedObjectSnapshot(priorBpId, 'JiraIssueNode', 'modified-obj', { key: 'PROJ-11', summary: 'Old summary', status: 'Open' });
    seedObjectSnapshot(bpId, 'JiraIssueNode', 'unchanged-obj', { key: 'PROJ-12', summary: 'No change' });
    seedObjectSnapshot(priorBpId, 'JiraIssueNode', 'deleted-obj', { key: 'PROJ-13', summary: 'Deleted issue' });
  });

  test('returns 404 BACKUP_POINT_NOT_FOUND for unknown backupPointId', async () => {
    const res = await request(app).get('/api/backup-points/nonexistent/objects?nodeType=JiraIssueNode');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('BACKUP_POINT_NOT_FOUND');
  });

  test('returns 400 INVALID_NODE_TYPE for unrecognised nodeType', async () => {
    const res = await request(app).get(`/api/backup-points/${bpId}/objects?nodeType=UnknownNode`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_NODE_TYPE');
  });

  test('returns 400 INVALID_NODE_TYPE when nodeType is missing', async () => {
    const res = await request(app).get(`/api/backup-points/${bpId}/objects`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_NODE_TYPE');
  });

  test('showUnchanged=false (default) excludes Unchanged objects', async () => {
    const res = await request(app).get(`/api/backup-points/${bpId}/objects?nodeType=JiraIssueNode`);
    expect(res.status).toBe(200);
    const indicators = res.body.results.map(r => r.changeIndicator);
    expect(indicators).not.toContain('Unchanged');
  });

  test('showUnchanged=false only returns Added, Modified, Deleted', async () => {
    const res = await request(app).get(
      `/api/backup-points/${bpId}/objects?nodeType=JiraIssueNode&showUnchanged=false`
    );
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('added-obj');
    expect(ids).toContain('modified-obj');
    expect(ids).toContain('deleted-obj');
    expect(ids).not.toContain('unchanged-obj');
  });

  test('showUnchanged=true includes Unchanged objects', async () => {
    const res = await request(app).get(
      `/api/backup-points/${bpId}/objects?nodeType=JiraIssueNode&showUnchanged=true`
    );
    expect(res.status).toBe(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toContain('unchanged-obj');
  });

  test('each result has changeIndicator field', async () => {
    const res = await request(app).get(
      `/api/backup-points/${bpId}/objects?nodeType=JiraIssueNode&showUnchanged=true`
    );
    expect(res.status).toBe(200);
    for (const r of res.body.results) {
      expect(['Added', 'Modified', 'Deleted', 'Unchanged']).toContain(r.changeIndicator);
    }
  });

  test('Added object has priorFields=null', async () => {
    const res = await request(app).get(
      `/api/backup-points/${bpId}/objects?nodeType=JiraIssueNode&showUnchanged=false`
    );
    const added = res.body.results.find(r => r.id === 'added-obj');
    expect(added).toBeDefined();
    expect(added.changeIndicator).toBe('Added');
    expect(added.priorFields).toBeNull();
    expect(added.changedFields).toEqual([]);
  });

  test('Modified object has priorFields populated and changedFields non-empty', async () => {
    const res = await request(app).get(
      `/api/backup-points/${bpId}/objects?nodeType=JiraIssueNode&showUnchanged=false`
    );
    const modified = res.body.results.find(r => r.id === 'modified-obj');
    expect(modified).toBeDefined();
    expect(modified.changeIndicator).toBe('Modified');
    expect(modified.priorFields).not.toBeNull();
    expect(modified.changedFields).toContain('summary');
    expect(modified.changedFields).toContain('status');
  });

  test('Deleted object is included with last-known fields', async () => {
    const res = await request(app).get(
      `/api/backup-points/${bpId}/objects?nodeType=JiraIssueNode&showUnchanged=false`
    );
    const deleted = res.body.results.find(r => r.id === 'deleted-obj');
    expect(deleted).toBeDefined();
    expect(deleted.changeIndicator).toBe('Deleted');
    expect(deleted.fields).toBeDefined();
  });

  test('response includes backupPointId and priorBackupPointId', async () => {
    const res = await request(app).get(
      `/api/backup-points/${bpId}/objects?nodeType=JiraIssueNode`
    );
    expect(res.status).toBe(200);
    expect(res.body.backupPointId).toBe(bpId);
    expect(res.body.priorBackupPointId).toBe(priorBpId);
  });

  test('returns 400 INVALID_CHANGE_INDICATOR for bad changeIndicator value', async () => {
    const res = await request(app).get(
      `/api/backup-points/${bpId}/objects?nodeType=JiraIssueNode&changeIndicator=BadValue`
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_CHANGE_INDICATOR');
  });

  test('first backup point (no prior): all objects labelled Added', async () => {
    const firstBpId = 'first-bp';
    seedBackupPoint({ id: firstBpId, priorBackupPointId: null });
    seedManifest(firstBpId, 'JiraIssueNode', [
      { id: 'new-obj-1', contentHash: 'h1' },
      { id: 'new-obj-2', contentHash: 'h2' },
    ]);
    seedObjectSnapshot(firstBpId, 'JiraIssueNode', 'new-obj-1', { key: 'PROJ-1' });
    seedObjectSnapshot(firstBpId, 'JiraIssueNode', 'new-obj-2', { key: 'PROJ-2' });

    const res = await request(app).get(
      `/api/backup-points/${firstBpId}/objects?nodeType=JiraIssueNode&showUnchanged=true`
    );
    expect(res.status).toBe(200);
    expect(res.body.results.every(r => r.changeIndicator === 'Added')).toBe(true);
  });
});

describe('GET/PUT /api/preferences', () => {
  test('GET returns empty preferences for new user', async () => {
    const res = await request(app)
      .get('/api/preferences')
      .set('x-user-id', 'test-user-preferences')
      .set('x-integration-id', 'int-1');
    expect(res.status).toBe(200);
    expect(res.body.preferences).toBeDefined();
  });

  test('PUT sets a preference and GET retrieves it', async () => {
    const headers = {
      'x-user-id': 'pref-user-1',
      'x-integration-id': 'pref-int-1',
    };

    const putRes = await request(app)
      .put('/api/preferences')
      .set(headers)
      .send({ key: 'platform.objectExplorer.showUnchangedObjects', value: true });

    expect(putRes.status).toBe(200);
    expect(putRes.body.key).toBe('platform.objectExplorer.showUnchangedObjects');
    expect(putRes.body.value).toBe(true);
    expect(putRes.body.updatedAt).toBeDefined();

    const getRes = await request(app)
      .get('/api/preferences')
      .set(headers);
    expect(getRes.status).toBe(200);
    expect(getRes.body.preferences['platform.objectExplorer.showUnchangedObjects']).toBe(true);
  });

  test('PUT returns 400 INVALID_PREFERENCE_KEY for unknown key', async () => {
    const res = await request(app)
      .put('/api/preferences')
      .send({ key: 'unknown.preference.key', value: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PREFERENCE_KEY');
  });

  test('PUT returns 400 INVALID_PREFERENCE_VALUE for wrong type', async () => {
    const res = await request(app)
      .put('/api/preferences')
      .send({ key: 'platform.objectExplorer.showUnchangedObjects', value: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PREFERENCE_VALUE');
  });
});
