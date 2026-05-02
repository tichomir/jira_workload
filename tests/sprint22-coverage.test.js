'use strict';

/**
 * Sprint 22 — Comprehensive Backup & Restore Coverage Tests
 *
 * TC-1: fetchIssuePage includes fields=*all and expand=names in JQL request params
 * TC-2: Restored issues carry [Restored from KEY] prefix in summary (create path)
 * TC-3: Restored issues carry [Restored from KEY] prefix in summary (update/revert path)
 * TC-4: Restored issues carry original-key:KEY label
 * TC-5: Custom fields from backup are included in issue create payload (same-site)
 * TC-6: 400 error from custom field validation results in warning logged and issue still created
 * TC-7: Summary prefix is idempotent — stripping existing prefix before re-prepending
 */

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '0ae79904e41359173d04fe7a63a93c289db8b411b9467cbc87e4d0646e4c133d';
process.env.ATLASSIAN_CLIENT_ID        = 'test-client-sprint22';
process.env.ATLASSIAN_CLIENT_SECRET    = 'test-secret-sprint22';
process.env.ATLASSIAN_REDIRECT_URI     = 'https://localhost:4443/oauth/callback';
process.env.NODE_ENV                   = 'test';

// ── Mocks ──────────────────────────────────────────────────────────────────

let mockJiraAxiosImpl = null;

jest.mock('../src/services/tokenService', () => ({
  getValidAccessToken: jest.fn().mockResolvedValue('mock-access-token-sprint22'),
  createJiraAxiosInstance: jest.fn().mockImplementation(() => mockJiraAxiosImpl),
  verifyAndRefreshCloudId: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('axios');

const { v4: uuidv4 } = require('uuid');

let db;
let initiateRestore;
let fetchIssuePage;

beforeAll(() => {
  jest.resetModules();
  db = require('../src/db');
  ({ initiateRestore } = require('../src/services/restoreOrchestrator'));
  ({ fetchIssuePage } = require('../src/services/jqlEnumeration'));
});

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function clearDb() {
  db.connections.clear();
  db.backupPoints.clear();
  db.backupJobs.clear();
  db.restoreJobs.clear();
  db.exportArchives.clear();
  db.restoredObjects.clear();
  db.objectSnapshots.clear();
  db.projectNodes.clear();
  db.workflowNodes.clear();
  db.customFieldDefinitions.clear();
  db.issueNodes && db.issueNodes.clear();
  mockJiraAxiosImpl = null;
}

beforeEach(clearDb);
afterEach(clearDb);

function seedConnection(overrides = {}) {
  const id = uuidv4();
  db.connections.set(id, {
    id,
    cloudId: 'cloud-test-site',
    siteId: 'cloud-test-site',
    status: 'active',
    accessToken: 'tok',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    cloudIdVerifiedAt: new Date().toISOString(),
    grantedScopes: [],
    deletedAt: null,
    ...overrides,
  });
  return id;
}

function seedBackupPoint(integrationId, overrides = {}) {
  const id = uuidv4();
  db.backupPoints.set(id, {
    id, integrationId,
    createdAt: new Date().toISOString(),
    priorBackupPointId: null,
    status: 'completed',
    objectCounts: {},
    ...overrides,
  });
  return id;
}

function seedSnapshot(backupPointId, nodeType, id, fields = {}, extra = {}) {
  const key = `${backupPointId}:${nodeType}:${id}`;
  db.objectSnapshots.set(key, { backupPointId, nodeType, id, fields, ...extra });
}

function seedProject(backupPointId, projKey, overrides = {}) {
  seedSnapshot(backupPointId, 'JiraProjectNode', projKey, {
    key: projKey, name: `Project ${projKey}`, projectTypeKey: 'software', ...overrides,
  });
}

function seedIssue(backupPointId, issueId, fields = {}, extra = {}) {
  const issueKey = fields.key || `TS-${issueId}`;
  const projectKey = (fields.project && fields.project.key) || issueKey.split('-')[0];
  seedSnapshot(backupPointId, 'JiraIssueNode', issueId, {
    key: issueKey,
    summary: `Issue ${issueId}`,
    issuetype: { name: 'Story' },
    project: { key: projectKey },
    comment: { comments: [] },
    labels: [],
    ...fields,
  }, { issueKey, projectKey, ...extra });
}

// ---------------------------------------------------------------------------
// TC-1: fetchIssuePage passes fields=*all and expand=names
// ---------------------------------------------------------------------------

describe('TC-1: fetchIssuePage passes fields=*all and expand=names', () => {
  test('fetchIssuePage request includes fields: *all and expand: names params', async () => {
    const capturedParams = [];
    const mockJiraAxios = {
      get: jest.fn().mockImplementation((url, config) => {
        capturedParams.push(config && config.params);
        return Promise.resolve({
          data: { issues: [], total: 0, startAt: 0, maxResults: 100 },
        });
      }),
    };

    await fetchIssuePage('cloud-test-site', mockJiraAxios, 'project="TS" ORDER BY updated ASC', 0);

    expect(mockJiraAxios.get).toHaveBeenCalledTimes(1);
    const params = capturedParams[0];
    expect(params).toBeDefined();
    expect(params.fields).toBe('*all');
    expect(params.expand).toBe('names');
    expect(params.jql).toBe('project="TS" ORDER BY updated ASC');
    expect(params.maxResults).toBe(100);
    expect(params.startAt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TC-2: Restored issues carry [Restored from KEY] prefix in summary (create path)
// ---------------------------------------------------------------------------

describe('TC-2: [Restored from KEY] summary prefix on issue create', () => {
  test('newly created issue has prefixed summary matching [Restored from TS-5]', async () => {
    const connId = seedConnection();
    const bpId   = seedBackupPoint(connId);

    seedProject(bpId, 'TS');
    seedIssue(bpId, '10005', {
      key: 'TS-5',
      summary: 'My original summary',
      project: { key: 'TS' },
      issuetype: { name: 'Story' },
    });

    const capturedPayloads = [];

    mockJiraAxiosImpl = {
      get: jest.fn().mockImplementation((url) => {
        // issue does not exist yet
        if (url.includes('/rest/api/3/issue/TS-5')) {
          const err = new Error('Not found'); err.response = { status: 404 }; err.isAxiosError = true;
          return Promise.reject(err);
        }
        // project does not exist → will fail on project POST (handled below)
        return Promise.reject(Object.assign(new Error('not found'), { response: { status: 404 }, isAxiosError: true }));
      }),
      post: jest.fn().mockImplementation((url, payload) => {
        capturedPayloads.push({ url, payload });
        if (url.includes('/rest/api/3/project')) {
          // simulate project already exists
          const err = new Error('already exists'); err.response = { status: 400 }; err.isAxiosError = true;
          return Promise.reject(err);
        }
        if (url.includes('/rest/api/3/issue')) {
          return Promise.resolve({ data: { id: 'new-10005', key: 'TS-5' } });
        }
        return Promise.resolve({ data: {} });
      }),
      put: jest.fn().mockResolvedValue({ data: {} }),
      delete: jest.fn().mockResolvedValue({ data: {} }),
    };

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'cloud-test-site',
      destination: { type: 'original', originalSiteId: 'cloud-test-site', isCrossSite: false },
      conflictMode: 'override',
      objectSelection: { includeAll: true },
      connectionId: connId,
    });

    // Find the issue create POST
    const issuePosts = capturedPayloads.filter(p => p.url.includes('/rest/api/3/issue') && !p.url.includes('/comment'));
    expect(issuePosts.length).toBeGreaterThanOrEqual(1);
    const issuePost = issuePosts[0];
    expect(issuePost.payload.fields.summary).toMatch(/^\[Restored from TS-5\]/);
    expect(issuePost.payload.fields.summary).toContain('My original summary');

    // Restore should succeed (project 400 → existing project, issue restored)
    expect(result.failedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TC-3: [Restored from KEY] prefix applied in update/revert path
// ---------------------------------------------------------------------------

describe('TC-3: [Restored from KEY] summary prefix on issue update (revert-in-place)', () => {
  test('existing issue updated with prefixed summary', async () => {
    const connId = seedConnection();
    const bpId   = seedBackupPoint(connId);

    seedProject(bpId, 'TS');
    seedIssue(bpId, '10006', {
      key: 'TS-6',
      summary: 'Revert me',
      project: { key: 'TS' },
      issuetype: { name: 'Story' },
      comment: { comments: [] },
    });

    const capturedPuts = [];

    mockJiraAxiosImpl = {
      get: jest.fn().mockImplementation((url) => {
        if (url.endsWith('/rest/api/3/issue/TS-6')) {
          return Promise.resolve({ data: { id: '10006', key: 'TS-6', fields: { summary: 'Revert me' } } });
        }
        if (url.includes('/rest/api/3/issue/TS-6/comment')) {
          return Promise.resolve({ data: { comments: [] } });
        }
        return Promise.reject(Object.assign(new Error('not found'), { response: { status: 404 }, isAxiosError: true }));
      }),
      post: jest.fn().mockImplementation((url) => {
        if (url.includes('/rest/api/3/project')) {
          const err = new Error('exists'); err.response = { status: 400 }; err.isAxiosError = true;
          return Promise.reject(err);
        }
        return Promise.resolve({ data: {} });
      }),
      put: jest.fn().mockImplementation((url, payload) => {
        capturedPuts.push({ url, payload });
        return Promise.resolve({ data: {} });
      }),
      delete: jest.fn().mockResolvedValue({ data: {} }),
    };

    await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'cloud-test-site',
      destination: { type: 'original', originalSiteId: 'cloud-test-site', isCrossSite: false },
      conflictMode: 'override',
      objectSelection: { includeAll: true },
      connectionId: connId,
    });

    const issuePuts = capturedPuts.filter(p => p.url.includes('/rest/api/3/issue/TS-6') && !p.url.includes('/comment'));
    expect(issuePuts.length).toBeGreaterThanOrEqual(1);
    expect(issuePuts[0].payload.fields.summary).toMatch(/^\[Restored from TS-6\]/);
    expect(issuePuts[0].payload.fields.summary).toContain('Revert me');
  });
});

// ---------------------------------------------------------------------------
// TC-4: Restored issues carry original-key:KEY label
// ---------------------------------------------------------------------------

describe('TC-4: original-key:KEY label is stamped on issue create', () => {
  test('issue create payload includes original-key:TS-7 label', async () => {
    const connId = seedConnection();
    const bpId   = seedBackupPoint(connId);

    seedProject(bpId, 'TS');
    seedIssue(bpId, '10007', {
      key: 'TS-7',
      summary: 'Label test',
      project: { key: 'TS' },
      labels: ['existing-label'],
    });

    const capturedPayloads = [];

    mockJiraAxiosImpl = {
      get: jest.fn().mockImplementation((url) => {
        if (url.includes('/rest/api/3/issue/TS-7')) {
          const err = new Error('Not found'); err.response = { status: 404 }; err.isAxiosError = true;
          return Promise.reject(err);
        }
        return Promise.reject(Object.assign(new Error('not found'), { response: { status: 404 }, isAxiosError: true }));
      }),
      post: jest.fn().mockImplementation((url, payload) => {
        capturedPayloads.push({ url, payload });
        if (url.includes('/rest/api/3/project')) {
          const err = new Error('exists'); err.response = { status: 400 }; err.isAxiosError = true;
          return Promise.reject(err);
        }
        if (url.includes('/rest/api/3/issue')) {
          return Promise.resolve({ data: { id: 'new-10007', key: 'TS-7' } });
        }
        return Promise.resolve({ data: {} });
      }),
      put: jest.fn().mockResolvedValue({ data: {} }),
      delete: jest.fn().mockResolvedValue({ data: {} }),
    };

    await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'cloud-test-site',
      destination: { type: 'original', originalSiteId: 'cloud-test-site', isCrossSite: false },
      conflictMode: 'override',
      objectSelection: { includeAll: true },
      connectionId: connId,
    });

    const issuePosts = capturedPayloads.filter(p => p.url.includes('/rest/api/3/issue') && !p.url.includes('/comment'));
    expect(issuePosts.length).toBeGreaterThanOrEqual(1);
    const labels = issuePosts[0].payload.fields.labels;
    expect(labels).toContain('original-key:TS-7');
    expect(labels).toContain('existing-label');
  });
});

// ---------------------------------------------------------------------------
// TC-5: Custom fields from backup are included in issue create payload (same-site)
// ---------------------------------------------------------------------------

describe('TC-5: Custom fields included in issue create payload for same-site restore', () => {
  test('custom field values from backup appear in issue create payload', async () => {
    const connId = seedConnection();
    const bpId   = seedBackupPoint(connId);

    seedProject(bpId, 'TS');
    seedIssue(bpId, '10008', {
      key: 'TS-8',
      summary: 'Custom fields test',
      project: { key: 'TS' },
      customfield_10001: 'sprint-A',
      customfield_10002: { value: 'High' },
      customfield_10003: null, // null — should be excluded
    });

    const capturedPayloads = [];

    mockJiraAxiosImpl = {
      get: jest.fn().mockImplementation((url) => {
        if (url.includes('/rest/api/3/issue/TS-8')) {
          const err = new Error('Not found'); err.response = { status: 404 }; err.isAxiosError = true;
          return Promise.reject(err);
        }
        return Promise.reject(Object.assign(new Error('not found'), { response: { status: 404 }, isAxiosError: true }));
      }),
      post: jest.fn().mockImplementation((url, payload) => {
        capturedPayloads.push({ url, payload });
        if (url.includes('/rest/api/3/project')) {
          const err = new Error('exists'); err.response = { status: 400 }; err.isAxiosError = true;
          return Promise.reject(err);
        }
        if (url.includes('/rest/api/3/issue')) {
          return Promise.resolve({ data: { id: 'new-10008', key: 'TS-8' } });
        }
        return Promise.resolve({ data: {} });
      }),
      put: jest.fn().mockResolvedValue({ data: {} }),
      delete: jest.fn().mockResolvedValue({ data: {} }),
    };

    await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'cloud-test-site',
      destination: { type: 'original', originalSiteId: 'cloud-test-site', isCrossSite: false },
      conflictMode: 'override',
      objectSelection: { includeAll: true },
      connectionId: connId,
    });

    const issuePosts = capturedPayloads.filter(p => p.url.includes('/rest/api/3/issue') && !p.url.includes('/comment'));
    expect(issuePosts.length).toBeGreaterThanOrEqual(1);
    const issueFields = issuePosts[0].payload.fields;

    // Non-null custom fields are included
    expect(issueFields.customfield_10001).toBe('sprint-A');
    expect(issueFields.customfield_10002).toEqual({ value: 'High' });
    // Null custom fields are excluded
    expect(issueFields).not.toHaveProperty('customfield_10003');
  });
});

// ---------------------------------------------------------------------------
// TC-6: 400 from custom field validation → retry without custom fields
// ---------------------------------------------------------------------------

describe('TC-6: 400 on issue create retries without custom fields', () => {
  test('when issue create returns 400, second attempt omits custom fields and succeeds', async () => {
    const connId = seedConnection();
    const bpId   = seedBackupPoint(connId);

    seedProject(bpId, 'TS');
    seedIssue(bpId, '10009', {
      key: 'TS-9',
      summary: 'Retry test',
      project: { key: 'TS' },
      customfield_10001: 'bad-field-value',
    });

    const capturedPayloads = [];
    const warnMessages = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnMessages.push(args.join(' '));

    let issueCreateCallCount = 0;

    mockJiraAxiosImpl = {
      get: jest.fn().mockImplementation((url) => {
        if (url.includes('/rest/api/3/issue/TS-9')) {
          const err = new Error('Not found'); err.response = { status: 404 }; err.isAxiosError = true;
          return Promise.reject(err);
        }
        return Promise.reject(Object.assign(new Error('not found'), { response: { status: 404 }, isAxiosError: true }));
      }),
      post: jest.fn().mockImplementation((url, payload) => {
        capturedPayloads.push({ url, payload });
        if (url.includes('/rest/api/3/project')) {
          const err = new Error('exists'); err.response = { status: 400 }; err.isAxiosError = true;
          return Promise.reject(err);
        }
        if (url.includes('/rest/api/3/issue') && !url.includes('/comment')) {
          issueCreateCallCount++;
          if (issueCreateCallCount === 1) {
            // First attempt: 400 from custom field validation
            const err = new Error('Custom field invalid');
            err.isAxiosError = true;
            err.response = { status: 400, data: { errors: { customfield_10001: 'Invalid value' } } };
            return Promise.reject(err);
          }
          // Second attempt: success
          return Promise.resolve({ data: { id: 'new-10009', key: 'TS-9' } });
        }
        return Promise.resolve({ data: {} });
      }),
      put: jest.fn().mockResolvedValue({ data: {} }),
      delete: jest.fn().mockResolvedValue({ data: {} }),
    };

    const result = await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'cloud-test-site',
      destination: { type: 'original', originalSiteId: 'cloud-test-site', isCrossSite: false },
      conflictMode: 'override',
      objectSelection: { includeAll: true },
      connectionId: connId,
    });

    console.warn = originalWarn;

    // Issue was still restored (not failed)
    expect(result.failedCount).toBe(0);

    // Two issue create calls were made
    expect(issueCreateCallCount).toBe(2);

    // Warning was logged
    const warnMsg = warnMessages.find(m => m.includes('retrying without custom fields'));
    expect(warnMsg).toBeDefined();

    // Second attempt omitted the custom field
    const issuePosts = capturedPayloads.filter(p =>
      p.url.includes('/rest/api/3/issue') && !p.url.includes('/comment'));
    expect(issuePosts.length).toBe(2);
    const fallbackPayload = issuePosts[1].payload;
    expect(fallbackPayload.fields).not.toHaveProperty('customfield_10001');
    // But still has the prefixed summary
    expect(fallbackPayload.fields.summary).toMatch(/^\[Restored from TS-9\]/);
  });
});

// ---------------------------------------------------------------------------
// TC-7: Summary prefix is idempotent (strip before prepend)
// ---------------------------------------------------------------------------

describe('TC-7: Summary prefix idempotent on re-restore', () => {
  test('existing [Restored from KEY] prefix is stripped before re-prepending', async () => {
    const connId = seedConnection();
    const bpId   = seedBackupPoint(connId);

    seedProject(bpId, 'TS');
    // Issue whose summary already has the prefix (e.g. backed up after a restore)
    seedIssue(bpId, '10010', {
      key: 'TS-10',
      summary: '[Restored from TS-10] Double prefix test',
      project: { key: 'TS' },
    });

    const capturedPayloads = [];

    mockJiraAxiosImpl = {
      get: jest.fn().mockImplementation((url) => {
        if (url.includes('/rest/api/3/issue/TS-10')) {
          const err = new Error('Not found'); err.response = { status: 404 }; err.isAxiosError = true;
          return Promise.reject(err);
        }
        return Promise.reject(Object.assign(new Error('not found'), { response: { status: 404 }, isAxiosError: true }));
      }),
      post: jest.fn().mockImplementation((url, payload) => {
        capturedPayloads.push({ url, payload });
        if (url.includes('/rest/api/3/project')) {
          const err = new Error('exists'); err.response = { status: 400 }; err.isAxiosError = true;
          return Promise.reject(err);
        }
        if (url.includes('/rest/api/3/issue')) {
          return Promise.resolve({ data: { id: 'new-10010', key: 'TS-10' } });
        }
        return Promise.resolve({ data: {} });
      }),
      put: jest.fn().mockResolvedValue({ data: {} }),
      delete: jest.fn().mockResolvedValue({ data: {} }),
    };

    await initiateRestore({
      backupPointId: bpId,
      sourceSiteId: 'cloud-test-site',
      destination: { type: 'original', originalSiteId: 'cloud-test-site', isCrossSite: false },
      conflictMode: 'override',
      objectSelection: { includeAll: true },
      connectionId: connId,
    });

    const issuePosts = capturedPayloads.filter(p =>
      p.url.includes('/rest/api/3/issue') && !p.url.includes('/comment'));
    expect(issuePosts.length).toBeGreaterThanOrEqual(1);

    const summary = issuePosts[0].payload.fields.summary;
    // Should NOT be double-prefixed
    expect(summary).not.toMatch(/\[Restored from.*\].*\[Restored from/);
    // Should have exactly one prefix
    expect(summary).toBe('[Restored from TS-10] Double prefix test');
  });
});
