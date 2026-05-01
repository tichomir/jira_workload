'use strict';

/**
 * Sprint 2 — Backup Discovery and Data Ingestion
 * Tests all acceptance criteria for the backend pipeline.
 */

// ---------------------------------------------------------------------------
// Mock axios BEFORE requiring any service modules
// ---------------------------------------------------------------------------
jest.mock('axios');
const axios = require('axios');

// ---------------------------------------------------------------------------
// Mock crypto service (avoids needing OAUTH_TOKEN_ENCRYPTION_KEY env var)
// ---------------------------------------------------------------------------
jest.mock('../src/services/crypto', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => v.replace(/^enc:/, ''),
}));

// ---------------------------------------------------------------------------
// Mock tokenService — prevents real HTTP token refresh in unit tests.
// createJiraAxiosInstance returns a minimal object that proxies to the mocked
// axios.get / axios.post so existing mock setups (axios.get.mockResolvedValue)
// continue to work transparently.
// ---------------------------------------------------------------------------
jest.mock('../src/services/tokenService', () => {
  const axiosMod = require('axios');
  return {
    getValidAccessToken: jest.fn().mockResolvedValue('test-access-token'),
    createJiraAxiosInstance: jest.fn(() => ({
      get: axiosMod.get,
      post: axiosMod.post,
    })),
    refreshConnectionToken: jest.fn().mockResolvedValue('test-access-token'),
  };
});

const db = require('../src/db');
const {
  formatJqlTimestamp,
  buildJql,
  fetchIssuePage,
  paginateAllIssues,
  getOrCreateRunState,
  runJqlEnumeration,
} = require('../src/services/jqlEnumeration');

const {
  findActiveLocalRegistration,
  ensureWebhookRegistered,
  buildWebhookJqlFilter,
  WEBHOOK_EVENTS,
} = require('../src/services/webhookRegistration');

const {
  processAttachments,
  findPriorManifestEntry,
  computeChecksum,
} = require('../src/services/attachmentMaterialisation');

const {
  enumerateWorkflows,
  enumerateCustomFields,
  enumerateCustomFieldContexts,
  runSiteEnumeration,
} = require('../src/services/siteObjectEnumeration');

const {
  tagProjectNode,
  tagIssueNodes,
  tagSprintNode,
} = require('../src/services/archiveScope');

const {
  assertPurgeCascadeAllowed,
  isPurgeCascadeExcluded,
  PURGE_EXCLUDED_NODE_TYPES,
} = require('../src/services/purgeCascade');

const {
  triggerManualSync,
  getOrCreateRefreshConfig,
  runScheduler,
  DEFAULT_REFRESH_INTERVAL_HOURS,
  completeRefreshJob,
} = require('../src/services/dataScopeRefresh');

const request = require('supertest');
const app = require('../src/app');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearDb() {
  db.backupRunStates.clear();
  db.webhookRegistrations.clear();
  db.attachmentManifestEntries.clear();
  db.dataScopeRefreshConfigs.clear();
  db.syncJobs.clear();
  db.issueNodes.clear();
  db.projectNodes.clear();
  db.sprintNodes.clear();
  db.workflowNodes.clear();
  db.customFieldDefinitions.clear();
  db.customFieldContextNodes.clear();
  db.connections.clear();
}

function makeConnection(overrides = {}) {
  const { v4: uuidv4 } = require('uuid');
  const id = uuidv4();
  const conn = {
    id,
    userId: 'user-1',
    cloudId: 'cloud-abc',
    siteName: 'Test Site',
    siteUrl: 'https://test.atlassian.net',
    accessToken: 'enc:test-access-token',
    refreshToken: 'enc:test-refresh-token',
    status: 'active',
    grantedScopes: ['read:jira-work', 'manage:jira-webhook'],
    missingRequiredScopes: [],
    boardScopeDegraded: false,
    projectScopeMode: 'all',
    selectedProjectIds: [],
    includeArchivedProjects: false,
    refreshTokenLastUsedAt: new Date().toISOString(),
    connectedAt: new Date().toISOString(),
    lastSyncedAt: null,
    softDeletedAt: null,
    hardDeletedAt: null,
    softDeleteRetentionDays: 30,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  db.connections.set(id, conn);
  return conn;
}

function makeIssue(key, overrides = {}) {
  return {
    id: `issue-${key}`,
    key,
    fields: {
      summary: `Summary of ${key}`,
      status: {
        name: 'Done',
        statusCategory: { key: 'done' },
      },
      attachment: [],
      ...overrides.fields,
    },
    ...overrides,
  };
}

/**
 * Returns a minimal jiraAxios mock that proxies to the mocked axios.get/post.
 * Pass this wherever functions previously accepted an accessToken string.
 */
function makeMockJiraAxios() {
  return { get: axios.get, post: axios.post };
}

// ---------------------------------------------------------------------------
// 1. JQL Enumeration — Full and Incremental
// ---------------------------------------------------------------------------

describe('JQL Enumeration', () => {
  beforeEach(() => {
    clearDb();
    axios.get.mockReset();
    axios.post.mockReset();
  });

  test('formatJqlTimestamp converts ISO 8601 to "YYYY-MM-DD HH:mm"', () => {
    expect(formatJqlTimestamp('2026-04-29T12:30:00.000Z')).toBe('2026-04-29 12:30');
    expect(formatJqlTimestamp('2026-01-01T00:00:00.000Z')).toBe('2026-01-01 00:00');
  });

  test('buildJql (full run) returns project-only JQL', () => {
    const jql = buildJql('PROJ', null);
    expect(jql).toBe('project="PROJ" ORDER BY updated ASC');
  });

  test('buildJql (incremental) includes updated>= clause with 60-second buffer', () => {
    const ts = '2026-04-29T12:01:00.000Z';
    const jql = buildJql('PROJ', ts);
    // With 60-second buffer: 2026-04-29T12:00:00.000Z → "2026-04-29 12:00"
    expect(jql).toContain('updated>="2026-04-29 12:00"');
    expect(jql).toContain('project="PROJ"');
    expect(jql).toContain('ORDER BY updated ASC');
  });

  test('full JQL enumeration paginates until all pages exhausted', async () => {
    // Page 1: 2 issues out of 3 total
    const issue1 = makeIssue('PROJ-1');
    const issue2 = makeIssue('PROJ-2');
    const issue3 = makeIssue('PROJ-3');

    axios.get
      .mockResolvedValueOnce({
        data: { issues: [issue1, issue2], total: 3, startAt: 0, maxResults: 2 },
      })
      .mockResolvedValueOnce({
        data: { issues: [issue3], total: 3, startAt: 2, maxResults: 2 },
      });

    const issues = await paginateAllIssues('integ-1', 'cloud-abc', makeMockJiraAxios(), 'project="PROJ" ORDER BY updated ASC');

    expect(issues).toHaveLength(3);
    expect(axios.get).toHaveBeenCalledTimes(2);
    // Both calls should have been made
    const firstCall = axios.get.mock.calls[0];
    expect(firstCall[1].params.startAt).toBe(0);
    const secondCall = axios.get.mock.calls[1];
    expect(secondCall[1].params.startAt).toBe(2);
  });

  test('full JQL run stores lastBackupTimestamp on success', async () => {
    const issue1 = makeIssue('PROJ-1');
    axios.get.mockResolvedValue({
      data: { issues: [issue1], total: 1, startAt: 0, maxResults: 100 },
    });

    const { runState, mode } = await runJqlEnumeration('integ-1', 'cloud-abc', 'PROJ', makeMockJiraAxios());

    expect(mode).toBe('full');
    expect(runState.lastBackupTimestamp).not.toBeNull();
    expect(runState.lastRunStatus).toBe('success');
  });

  test('incremental run uses lastBackupTimestamp from prior run', async () => {
    // Set up a prior run state
    const { v4: uuidv4 } = require('uuid');
    const priorState = {
      id: uuidv4(),
      integrationId: 'integ-2',
      cloudId: 'cloud-abc',
      projectKey: 'PROJ',
      lastBackupTimestamp: '2026-04-01T10:00:00.000Z',
      lastRunStatus: 'success',
      lastRunCompletedAt: '2026-04-01T10:05:00.000Z',
    };
    db.backupRunStates.set(priorState.id, priorState);

    const issue1 = makeIssue('PROJ-5');
    axios.get.mockResolvedValue({
      data: { issues: [issue1], total: 1, startAt: 0, maxResults: 100 },
    });

    const { mode } = await runJqlEnumeration('integ-2', 'cloud-abc', 'PROJ', makeMockJiraAxios());

    expect(mode).toBe('incremental');
    // Verify the JQL contained updated>= clause
    const callArgs = axios.get.mock.calls[0];
    expect(callArgs[1].params.jql).toContain('updated>="');
  });

  test('IssueNodes are upserted into db.issueNodes', async () => {
    const issue1 = makeIssue('PROJ-10');
    axios.get.mockResolvedValue({
      data: { issues: [issue1], total: 1, startAt: 0, maxResults: 100 },
    });

    await runJqlEnumeration('integ-3', 'cloud-abc', 'PROJ', makeMockJiraAxios());

    expect(db.issueNodes.has('integ-3:PROJ-10')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Webhook Registration — Idempotency
// ---------------------------------------------------------------------------

describe('Webhook Registration', () => {
  beforeEach(() => {
    clearDb();
    axios.get.mockReset();
    axios.post.mockReset();
  });

  test('registers webhook with correct events on first call', async () => {
    axios.post.mockResolvedValue({
      data: { webhookRegistrationResult: [{ createdWebhookId: 42 }] },
    });

    const { webhookId, registered } = await ensureWebhookRegistered(
      'integ-1', 'cloud-abc', 'token', null
    );

    expect(registered).toBe(true);
    expect(webhookId).toBe(42);
    // Verify the registered events
    const postBody = axios.post.mock.calls[0][1];
    expect(postBody.webhooks[0].events).toEqual(
      expect.arrayContaining(['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted'])
    );
  });

  test('idempotent: does not re-register if active registration exists', async () => {
    // Pre-register in local store
    const { v4: uuidv4 } = require('uuid');
    const reg = {
      id: uuidv4(),
      integrationId: 'integ-2',
      cloudId: 'cloud-abc',
      webhookId: 99,
      jqlFilter: null,
      events: WEBHOOK_EVENTS,
      registeredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      deletedAt: null,
    };
    db.webhookRegistrations.set(reg.id, reg);

    const { webhookId, registered } = await ensureWebhookRegistered(
      'integ-2', 'cloud-abc', 'token', null
    );

    expect(registered).toBe(false);
    expect(webhookId).toBe(99);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('re-registers if existing registration is expired', async () => {
    const { v4: uuidv4 } = require('uuid');
    const expiredReg = {
      id: uuidv4(),
      integrationId: 'integ-3',
      cloudId: 'cloud-abc',
      webhookId: 10,
      events: WEBHOOK_EVENTS,
      registeredAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-31T00:00:00.000Z', // expired
      deletedAt: null,
    };
    db.webhookRegistrations.set(expiredReg.id, expiredReg);

    axios.post.mockResolvedValue({
      data: { webhookRegistrationResult: [{ createdWebhookId: 55 }] },
    });

    const { webhookId, registered } = await ensureWebhookRegistered(
      'integ-3', 'cloud-abc', 'token', null
    );

    expect(registered).toBe(true);
    expect(webhookId).toBe(55);
  });

  test('buildWebhookJqlFilter returns null for all-projects mode', () => {
    const conn = makeConnection({ projectScopeMode: 'all', selectedProjectIds: [] });
    expect(buildWebhookJqlFilter(conn)).toBeNull();
  });

  test('buildWebhookJqlFilter returns project-scoped JQL for selected mode', () => {
    const conn = makeConnection({
      projectScopeMode: 'selected',
      selectedProjectIds: ['PROJ-A', 'PROJ-B'],
    });
    expect(buildWebhookJqlFilter(conn)).toBe('project in (PROJ-A,PROJ-B)');
  });

  test('WebhookRegistration record stores correct events', async () => {
    axios.post.mockResolvedValue({
      data: { webhookRegistrationResult: [{ createdWebhookId: 77 }] },
    });

    await ensureWebhookRegistered('integ-4', 'cloud-abc', 'token', null);

    const reg = [...db.webhookRegistrations.values()].find(
      (r) => r.integrationId === 'integ-4'
    );
    expect(reg).toBeDefined();
    expect(reg.events).toContain('jira:issue_created');
    expect(reg.events).toContain('jira:issue_updated');
    expect(reg.events).toContain('jira:issue_deleted');
  });
});

// ---------------------------------------------------------------------------
// 3. Attachment Binary Materialisation & Deduplication
// ---------------------------------------------------------------------------

describe('Attachment Materialisation', () => {
  beforeEach(() => {
    clearDb();
    axios.get.mockReset();
  });

  test('downloads binary for new attachment IDs', async () => {
    const binaryData = Buffer.from('fake-binary-content');
    axios.get.mockResolvedValue({ data: binaryData.buffer });

    const issues = [
      {
        key: 'PROJ-1',
        fields: {
          attachment: [{ id: 'att-001', filename: 'file.txt', mimeType: 'text/plain', size: 100 }],
        },
      },
    ];

    const entries = await processAttachments('integ-1', 'bp-1', issues, 'cloud-abc', makeMockJiraAxios());

    expect(entries).toHaveLength(1);
    expect(entries[0].sidecarOnly).toBe(false);
    expect(entries[0].binaryStorageRef).toBeTruthy();
    expect(entries[0].attachmentId).toBe('att-001');
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/attachment/content/att-001'),
      expect.any(Object)
    );
  });

  test('carry-forward sidecar for attachment IDs in prior manifest', async () => {
    const { v4: uuidv4 } = require('uuid');
    // Pre-populate a prior manifest entry
    const priorEntry = {
      id: uuidv4(),
      integrationId: 'integ-2',
      backupPointId: 'bp-prev',
      attachmentId: 'att-100',
      issueKey: 'PROJ-1',
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 500,
      binaryStorageRef: 'integrations/integ-2/attachments/att-100',
      sidecarOnly: false,
      priorManifestEntryId: null,
      downloadedAt: new Date().toISOString(),
      checksum: 'abc123',
    };
    db.attachmentManifestEntries.set(priorEntry.id, priorEntry);

    const issues = [
      {
        key: 'PROJ-1',
        fields: {
          attachment: [{ id: 'att-100', filename: 'doc.pdf', mimeType: 'application/pdf', size: 500 }],
        },
      },
    ];

    const entries = await processAttachments('integ-2', 'bp-2', issues, 'cloud-abc', makeMockJiraAxios());

    expect(entries).toHaveLength(1);
    expect(entries[0].sidecarOnly).toBe(true);
    expect(entries[0].binaryStorageRef).toBeNull();
    expect(entries[0].priorManifestEntryId).toBe(priorEntry.id);
    // Should NOT have made an HTTP call
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('deduplication: same attachmentId within a single run only processed once', async () => {
    const binaryData = Buffer.from('data');
    axios.get.mockResolvedValue({ data: binaryData.buffer });

    const issues = [
      { key: 'PROJ-1', fields: { attachment: [{ id: 'att-200', filename: 'a.txt', size: 10 }] } },
      { key: 'PROJ-2', fields: { attachment: [{ id: 'att-200', filename: 'a.txt', size: 10 }] } },
    ];

    const entries = await processAttachments('integ-3', 'bp-3', issues, 'cloud-abc', makeMockJiraAxios());

    // Only one entry created, download called once
    expect(entries).toHaveLength(1);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('manifest entries persisted atomically in db.attachmentManifestEntries', async () => {
    const binaryData = Buffer.from('content');
    axios.get.mockResolvedValue({ data: binaryData.buffer });

    const issues = [
      { key: 'PROJ-1', fields: { attachment: [{ id: 'att-300', filename: 'x.bin', size: 7 }] } },
    ];

    await processAttachments('integ-4', 'bp-4', issues, 'cloud-abc', makeMockJiraAxios());

    const stored = [...db.attachmentManifestEntries.values()].find(
      (e) => e.attachmentId === 'att-300' && e.integrationId === 'integ-4'
    );
    expect(stored).toBeDefined();
    expect(stored.checksum).toBeTruthy();
  });

  test('computeChecksum returns SHA-256 hex string', () => {
    const buf = Buffer.from('hello');
    const hash = computeChecksum(buf);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// 4. Site-Level Object Enumeration
// ---------------------------------------------------------------------------

describe('Site-Level Object Enumeration', () => {
  beforeEach(() => {
    clearDb();
    axios.get.mockReset();
  });

  test('enumerateWorkflows paginates with isLast stop condition', async () => {
    const wf1 = { id: 'wf-1', name: 'Workflow 1' };
    const wf2 = { id: 'wf-2', name: 'Workflow 2' };
    const wf3 = { id: 'wf-3', name: 'Workflow 3' };

    axios.get
      .mockResolvedValueOnce({ data: { values: [wf1, wf2], isLast: false, total: 3 } })
      .mockResolvedValueOnce({ data: { values: [wf3], isLast: true, total: 3 } });

    const workflows = await enumerateWorkflows('cloud-abc', makeMockJiraAxios());

    expect(workflows).toHaveLength(3);
    expect(db.workflowNodes.size).toBe(3);
    expect(db.workflowNodes.has('cloud-abc:wf-1')).toBe(true);
    expect(db.workflowNodes.has('cloud-abc:wf-2')).toBe(true);
    expect(db.workflowNodes.has('cloud-abc:wf-3')).toBe(true);
  });

  test('enumerateCustomFields stores all fields from single-response API', async () => {
    const fields = [
      { id: 'customfield_10001', name: 'Story Points', schema: { type: 'number' } },
      { id: 'customfield_10002', name: 'Priority', schema: { type: 'select' } },
    ];
    axios.get.mockResolvedValue({ data: fields });

    const result = await enumerateCustomFields('cloud-abc', makeMockJiraAxios());

    expect(result).toHaveLength(2);
    expect(db.customFieldDefinitions.size).toBe(2);
    expect(db.customFieldDefinitions.has('cloud-abc:customfield_10001')).toBe(true);
    expect(db.customFieldDefinitions.has('cloud-abc:customfield_10002')).toBe(true);
  });

  test('enumerateCustomFieldContexts paginates contexts and enumerates options for select fields', async () => {
    // First call: contexts
    const ctx1 = { id: 'ctx-1', name: 'Global Context', isGlobalContext: true };
    // Second call: options for ctx-1
    const opt1 = { id: 'opt-1', value: 'Option A' };
    const opt2 = { id: 'opt-2', value: 'Option B' };

    axios.get
      .mockResolvedValueOnce({ data: { values: [ctx1], isLast: true } })
      .mockResolvedValueOnce({ data: { values: [opt1, opt2], isLast: true } });

    const nodes = await enumerateCustomFieldContexts('cloud-abc', makeMockJiraAxios(), 'customfield_10002', 'select');

    expect(nodes).toHaveLength(1);
    expect(nodes[0].options).toHaveLength(2);
    expect(db.customFieldContextNodes.has('cloud-abc:customfield_10002:ctx-1')).toBe(true);
  });

  test('enumerateCustomFieldContexts does NOT enumerate options for non-select field types', async () => {
    const ctx1 = { id: 'ctx-10', name: 'Context', isGlobalContext: false };
    axios.get.mockResolvedValueOnce({ data: { values: [ctx1], isLast: true } });

    await enumerateCustomFieldContexts('cloud-abc', makeMockJiraAxios(), 'customfield_99', 'number');

    // Only 1 API call (contexts only, no options)
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('runSiteEnumeration runs workflows and fields concurrently then contexts', async () => {
    // Workflows
    axios.get
      .mockResolvedValueOnce({ data: { values: [{ id: 'wf-1', name: 'WF1' }], isLast: true } }) // workflows
      .mockResolvedValueOnce({ data: [{ id: 'customfield_1', name: 'CF1', schema: { type: 'number' } }] }) // fields
      .mockResolvedValueOnce({ data: { values: [], isLast: true } }); // contexts for CF1

    const result = await runSiteEnumeration('cloud-abc', makeMockJiraAxios());

    expect(result.workflows).toHaveLength(1);
    expect(result.fields).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Archive Scope Attribute Tagging
// ---------------------------------------------------------------------------

describe('Archive Scope Attribute Tagging', () => {
  beforeEach(() => {
    clearDb();
  });

  test('tagProjectNode sets archived=true when project.archived=true', () => {
    tagProjectNode('integ-1', { key: 'PROJ', id: 'p1', name: 'Proj', archived: true });
    const node = db.projectNodes.get('integ-1:PROJ');
    expect(node.archived).toBe(true);
  });

  test('tagProjectNode sets archived=false when project.archived is not true', () => {
    tagProjectNode('integ-1', { key: 'PROJ2', id: 'p2', name: 'Proj2', archived: false });
    const node = db.projectNodes.get('integ-1:PROJ2');
    expect(node.archived).toBe(false);
  });

  test('tagIssueNodes sets statusCategory=done for done-category issues', () => {
    const issue = makeIssue('PROJ-1', {
      fields: { status: { statusCategory: { key: 'done' } }, attachment: [] },
    });
    db.issueNodes.set('integ-1:PROJ-1', {
      integrationId: 'integ-1',
      issueKey: 'PROJ-1',
      statusCategory: null,
    });

    tagIssueNodes('integ-1', [issue]);

    const node = db.issueNodes.get('integ-1:PROJ-1');
    expect(node.statusCategory).toBe('done');
  });

  test('tagSprintNode sets state=closed for closed sprints', () => {
    tagSprintNode('integ-1', { id: 'sprint-1', name: 'Sprint 1', state: 'closed' });
    const node = db.sprintNodes.get('integ-1:sprint-1');
    expect(node.state).toBe('closed');
  });

  test('tagSprintNode sets state=active for active sprints', () => {
    tagSprintNode('integ-1', { id: 'sprint-2', name: 'Sprint 2', state: 'active' });
    const node = db.sprintNodes.get('integ-1:sprint-2');
    expect(node.state).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// 6. Purge Cascade Boundary Enforcement
// ---------------------------------------------------------------------------

describe('Purge Cascade Boundary Enforcement', () => {
  test('assertPurgeCascadeAllowed throws for JiraWorkflowNode', () => {
    expect(() => assertPurgeCascadeAllowed('JiraWorkflowNode')).toThrow();
    try {
      assertPurgeCascadeAllowed('JiraWorkflowNode');
    } catch (err) {
      expect(err.code).toBe('PURGE_CASCADE_BOUNDARY_VIOLATION');
      expect(err.status).toBe(409);
    }
  });

  test('assertPurgeCascadeAllowed throws for JiraCustomFieldDefinitionNode', () => {
    expect(() => assertPurgeCascadeAllowed('JiraCustomFieldDefinitionNode')).toThrow();
  });

  test('assertPurgeCascadeAllowed throws for JiraCustomFieldContextNode', () => {
    expect(() => assertPurgeCascadeAllowed('JiraCustomFieldContextNode')).toThrow();
  });

  test('assertPurgeCascadeAllowed does NOT throw for JiraIssueNode', () => {
    expect(() => assertPurgeCascadeAllowed('JiraIssueNode')).not.toThrow();
  });

  test('assertPurgeCascadeAllowed does NOT throw for JiraProjectNode', () => {
    expect(() => assertPurgeCascadeAllowed('JiraProjectNode')).not.toThrow();
  });

  test('isPurgeCascadeExcluded returns true for excluded types', () => {
    expect(isPurgeCascadeExcluded('JiraWorkflowNode')).toBe(true);
    expect(isPurgeCascadeExcluded('JiraCustomFieldDefinitionNode')).toBe(true);
    expect(isPurgeCascadeExcluded('JiraCustomFieldContextNode')).toBe(true);
  });

  test('isPurgeCascadeExcluded returns false for non-excluded types', () => {
    expect(isPurgeCascadeExcluded('JiraIssueNode')).toBe(false);
    expect(isPurgeCascadeExcluded('JiraProjectNode')).toBe(false);
    expect(isPurgeCascadeExcluded('JiraSprintNode')).toBe(false);
  });

  test('POST /api/v1/purge/cascade returns 409 for excluded JiraWorkflowNode', async () => {
    const res = await request(app)
      .post('/api/v1/purge/cascade')
      .send({ nodeType: 'JiraWorkflowNode', targetId: 'wf-1' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PURGE_CASCADE_BOUNDARY_VIOLATION');
    expect(res.body.nodeType).toBe('JiraWorkflowNode');
  });

  test('POST /api/v1/purge/cascade returns 409 for JiraCustomFieldDefinitionNode', async () => {
    const res = await request(app)
      .post('/api/v1/purge/cascade')
      .send({ nodeType: 'JiraCustomFieldDefinitionNode' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PURGE_CASCADE_BOUNDARY_VIOLATION');
  });

  test('POST /api/v1/purge/cascade returns 409 for JiraCustomFieldContextNode', async () => {
    const res = await request(app)
      .post('/api/v1/purge/cascade')
      .send({ nodeType: 'JiraCustomFieldContextNode' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PURGE_CASCADE_BOUNDARY_VIOLATION');
  });

  test('POST /api/v1/purge/cascade returns 200 for JiraIssueNode', async () => {
    const res = await request(app)
      .post('/api/v1/purge/cascade')
      .send({ nodeType: 'JiraIssueNode', targetId: 'issue-1' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cascade_accepted');
  });

  test('POST /api/v1/purge/cascade returns 400 when nodeType missing', async () => {
    const res = await request(app)
      .post('/api/v1/purge/cascade')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_NODE_TYPE');
  });
});

// ---------------------------------------------------------------------------
// 7. Data Scope Refresh Scheduler & Sync Now
// ---------------------------------------------------------------------------

describe('Data Scope Refresh', () => {
  beforeEach(() => {
    clearDb();
  });

  test('getOrCreateRefreshConfig creates a config with 24h default interval', () => {
    const config = getOrCreateRefreshConfig('integ-1');
    expect(config.refreshIntervalHours).toBe(DEFAULT_REFRESH_INTERVAL_HOURS);
    expect(DEFAULT_REFRESH_INTERVAL_HOURS).toBe(24);
    expect(config.manualSyncPending).toBe(false);
    expect(config.integrationId).toBe('integ-1');
  });

  test('getOrCreateRefreshConfig returns existing config on second call', () => {
    const c1 = getOrCreateRefreshConfig('integ-2');
    const c2 = getOrCreateRefreshConfig('integ-2');
    expect(c1.id).toBe(c2.id);
  });

  test('triggerManualSync enqueues a high-priority job and sets manualSyncPending=true', () => {
    makeConnection({ id: 'integ-3' });
    const { job, alreadyInProgress } = triggerManualSync('integ-3');

    expect(alreadyInProgress).toBe(false);
    expect(job.status).toBe('queued');
    expect(job.priority).toBe('high');
    expect(job.type).toBe('manual');

    const config = db.dataScopeRefreshConfigs.get('integ-3');
    expect(config.manualSyncPending).toBe(true);
  });

  test('triggerManualSync returns existing job if one is already in_progress', () => {
    const { v4: uuidv4 } = require('uuid');
    const inProgressJob = {
      id: uuidv4(),
      integrationId: 'integ-4',
      type: 'manual',
      priority: 'high',
      status: 'in_progress',
      triggeredAt: new Date().toISOString(),
      completedAt: null,
    };
    db.syncJobs.set(inProgressJob.id, inProgressJob);

    const { job, alreadyInProgress } = triggerManualSync('integ-4');

    expect(alreadyInProgress).toBe(true);
    expect(job.id).toBe(inProgressJob.id);
  });

  test('POST /api/v1/integrations/:id/sync returns 200 with jobId', async () => {
    const conn = makeConnection();
    const res = await request(app)
      .post(`/api/v1/integrations/${conn.id}/sync`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.jobId).toBeTruthy();
    expect(res.body.status).toBe('queued');
    expect(res.body.triggeredAt).toBeTruthy();
  });

  test('POST /api/v1/integrations/:id/sync returns 202 if job already in_progress', async () => {
    const { v4: uuidv4 } = require('uuid');
    const conn = makeConnection();
    const inProgressJob = {
      id: uuidv4(),
      integrationId: conn.id,
      type: 'manual',
      priority: 'high',
      status: 'in_progress',
      triggeredAt: new Date().toISOString(),
      completedAt: null,
    };
    db.syncJobs.set(inProgressJob.id, inProgressJob);

    const res = await request(app)
      .post(`/api/v1/integrations/${conn.id}/sync`)
      .send();

    expect(res.status).toBe(202);
    expect(res.body.alreadyInProgress).toBe(true);
    expect(res.body.jobId).toBe(inProgressJob.id);
  });

  test('runScheduler enqueues jobs for integrations past their nextScheduledAt', () => {
    // Create a config with a past nextScheduledAt
    const pastDate = new Date(Date.now() - 1000).toISOString();
    db.dataScopeRefreshConfigs.set('integ-5', {
      id: 'cfg-5',
      integrationId: 'integ-5',
      refreshIntervalHours: 24,
      lastRefreshedAt: null,
      nextScheduledAt: pastDate,
      manualSyncPending: false,
    });

    // Create a config with a future nextScheduledAt (should not fire)
    const futureDate = new Date(Date.now() + 999999).toISOString();
    db.dataScopeRefreshConfigs.set('integ-6', {
      id: 'cfg-6',
      integrationId: 'integ-6',
      refreshIntervalHours: 24,
      lastRefreshedAt: null,
      nextScheduledAt: futureDate,
      manualSyncPending: false,
    });

    const jobs = runScheduler();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].integrationId).toBe('integ-5');
    expect(jobs[0].type).toBe('scheduled');
    expect(jobs[0].priority).toBe('normal');
  });

  test('completeRefreshJob updates lastRefreshedAt and resets manualSyncPending', () => {
    const { v4: uuidv4 } = require('uuid');
    getOrCreateRefreshConfig('integ-7');
    const job = {
      id: uuidv4(),
      integrationId: 'integ-7',
      type: 'manual',
      priority: 'high',
      status: 'in_progress',
      triggeredAt: new Date().toISOString(),
      completedAt: null,
    };
    db.syncJobs.set(job.id, job);

    completeRefreshJob(job.id);

    const completedJob = db.syncJobs.get(job.id);
    expect(completedJob.status).toBe('completed');
    expect(completedJob.completedAt).toBeTruthy();

    const config = db.dataScopeRefreshConfigs.get('integ-7');
    expect(config.lastRefreshedAt).toBeTruthy();
    expect(config.manualSyncPending).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. HTTP API Routes
// ---------------------------------------------------------------------------

describe('Backup API Routes', () => {
  beforeEach(() => {
    clearDb();
    axios.get.mockReset();
    axios.post.mockReset();
  });

  test('GET /api/v1/integrations/:id/backup/run-states returns 404 for unknown integration', async () => {
    const res = await request(app).get('/api/v1/integrations/nonexistent/backup/run-states');
    expect(res.status).toBe(404);
  });

  test('GET /api/v1/integrations/:id/backup/run-states returns run states', async () => {
    const conn = makeConnection();
    const { v4: uuidv4 } = require('uuid');
    db.backupRunStates.set('rs-1', {
      id: 'rs-1',
      integrationId: conn.id,
      cloudId: 'cloud-abc',
      projectKey: 'PROJ',
      lastBackupTimestamp: '2026-04-01T00:00:00.000Z',
      lastRunStatus: 'success',
      lastRunCompletedAt: '2026-04-01T01:00:00.000Z',
    });

    const res = await request(app).get(`/api/v1/integrations/${conn.id}/backup/run-states`);
    expect(res.status).toBe(200);
    expect(res.body.runStates).toHaveLength(1);
    expect(res.body.runStates[0].projectKey).toBe('PROJ');
    expect(res.body.runStates[0].lastBackupTimestamp).toBe('2026-04-01T00:00:00.000Z');
  });

  test('GET /api/v1/integrations/:id/webhooks returns webhook registrations', async () => {
    const conn = makeConnection();
    const { v4: uuidv4 } = require('uuid');
    db.webhookRegistrations.set('wr-1', {
      id: 'wr-1',
      integrationId: conn.id,
      cloudId: 'cloud-abc',
      webhookId: 42,
      events: WEBHOOK_EVENTS,
      jqlFilter: null,
      registeredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      deletedAt: null,
    });

    const res = await request(app).get(`/api/v1/integrations/${conn.id}/webhooks`);
    expect(res.status).toBe(200);
    expect(res.body.registrations).toHaveLength(1);
    expect(res.body.registrations[0].webhookId).toBe(42);
  });

  test('GET /api/v1/integrations/:id/attachments returns manifest entries', async () => {
    const conn = makeConnection();
    const { v4: uuidv4 } = require('uuid');
    db.attachmentManifestEntries.set('am-1', {
      id: 'am-1',
      integrationId: conn.id,
      backupPointId: 'bp-1',
      attachmentId: 'att-999',
      issueKey: 'PROJ-1',
      filename: 'test.txt',
      sidecarOnly: false,
      binaryStorageRef: 'integrations/test/att-999',
      checksum: 'abc',
      downloadedAt: new Date().toISOString(),
    });

    const res = await request(app).get(`/api/v1/integrations/${conn.id}/attachments`);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].attachmentId).toBe('att-999');
  });

  test('GET /api/v1/integrations/:id/sync/config returns 24h default', async () => {
    const conn = makeConnection();
    const res = await request(app).get(`/api/v1/integrations/${conn.id}/sync/config`);
    expect(res.status).toBe(200);
    expect(res.body.refreshIntervalHours).toBe(24);
    expect(res.body.integrationId).toBe(conn.id);
  });
});

// ---------------------------------------------------------------------------
// 9. Acceptance Criteria — Explicit Scenarios
// ---------------------------------------------------------------------------

describe('AC: Full JQL Enumeration — 3 pages × 100 issues = 300 total', () => {
  beforeEach(() => {
    clearDb();
    axios.get.mockReset();
  });

  test('ingests 300 issues from 3 pages and records lastBackupTimestamp', async () => {
    // Build 100 issues per page with a predictable updated field
    function makePage(pageIndex, count) {
      const issues = [];
      for (let i = 0; i < count; i++) {
        const n = pageIndex * 100 + i + 1;
        issues.push({
          id: `issue-${n}`,
          key: `PROJ-${n}`,
          fields: {
            summary: `Issue ${n}`,
            status: { name: 'Open', statusCategory: { key: 'new' } },
            attachment: [],
            updated: `2026-04-${String(pageIndex + 1).padStart(2, '0')}T00:00:00.000Z`,
          },
        });
      }
      return issues;
    }

    // Three pages: each returns 100 issues; total=300
    axios.get
      .mockResolvedValueOnce({ data: { issues: makePage(0, 100), total: 300, startAt: 0, maxResults: 100 } })
      .mockResolvedValueOnce({ data: { issues: makePage(1, 100), total: 300, startAt: 100, maxResults: 100 } })
      .mockResolvedValueOnce({ data: { issues: makePage(2, 100), total: 300, startAt: 200, maxResults: 100 } });

    const issues = await paginateAllIssues('integ-ac1', 'cloud-abc', makeMockJiraAxios(),
      'project="PROJ" ORDER BY updated ASC');

    expect(issues).toHaveLength(300);
    expect(axios.get).toHaveBeenCalledTimes(3);

    // Verify startAt offsets were correct
    expect(axios.get.mock.calls[0][1].params.startAt).toBe(0);
    expect(axios.get.mock.calls[1][1].params.startAt).toBe(100);
    expect(axios.get.mock.calls[2][1].params.startAt).toBe(200);

    // All 300 issueNodes ingested
    expect(db.issueNodes.size).toBe(300);
  });

  test('runJqlEnumeration sets lastBackupTimestamp on success (full run)', async () => {
    function makeSimplePage(count, startIdx) {
      const issues = [];
      for (let i = 0; i < count; i++) {
        const n = startIdx + i + 1;
        issues.push(makeIssue(`PROJ-${n}`));
      }
      return issues;
    }

    axios.get
      .mockResolvedValueOnce({ data: { issues: makeSimplePage(100, 0), total: 300, startAt: 0, maxResults: 100 } })
      .mockResolvedValueOnce({ data: { issues: makeSimplePage(100, 100), total: 300, startAt: 100, maxResults: 100 } })
      .mockResolvedValueOnce({ data: { issues: makeSimplePage(100, 200), total: 300, startAt: 200, maxResults: 100 } });

    const beforeRun = new Date();
    const { runState, mode } = await runJqlEnumeration('integ-ac2', 'cloud-abc', 'PROJ', makeMockJiraAxios());

    expect(mode).toBe('full');
    expect(runState.lastBackupTimestamp).not.toBeNull();
    expect(runState.lastRunStatus).toBe('success');
    // Timestamp must be >= the start of the run
    expect(new Date(runState.lastBackupTimestamp).getTime()).toBeGreaterThanOrEqual(beforeRun.getTime() - 1000);
  });
});

describe('AC: Incremental Cursor Correctness', () => {
  beforeEach(() => {
    clearDb();
    axios.get.mockReset();
  });

  test('second run uses lastBackupTimestamp from first run in JQL query', async () => {
    // First run — full
    axios.get.mockResolvedValueOnce({
      data: { issues: [makeIssue('PROJ-1')], total: 1, startAt: 0, maxResults: 100 },
    });
    const { runState } = await runJqlEnumeration('integ-inc1', 'cloud-abc', 'PROJ', makeMockJiraAxios());
    const firstTimestamp = runState.lastBackupTimestamp;
    expect(firstTimestamp).not.toBeNull();

    // Reset mock for second run
    axios.get.mockReset();
    axios.get.mockResolvedValueOnce({
      data: { issues: [makeIssue('PROJ-2')], total: 1, startAt: 0, maxResults: 100 },
    });

    const { mode } = await runJqlEnumeration('integ-inc1', 'cloud-abc', 'PROJ', makeMockJiraAxios());
    expect(mode).toBe('incremental');

    const secondCallJql = axios.get.mock.calls[0][1].params.jql;
    // The JQL must contain an updated>= clause derived from the first run timestamp
    expect(secondCallJql).toMatch(/updated>="/);
    expect(secondCallJql).toContain('ORDER BY updated ASC');
  });
});

describe('AC: Webhook Idempotency — call twice, only one Jira API registration', () => {
  beforeEach(() => {
    clearDb();
    axios.post.mockReset();
  });

  test('calling ensureWebhookRegistered twice only hits Jira API once', async () => {
    axios.post.mockResolvedValue({
      data: { webhookRegistrationResult: [{ createdWebhookId: 101 }] },
    });

    const result1 = await ensureWebhookRegistered('integ-wh1', 'cloud-abc', 'token', null);
    const result2 = await ensureWebhookRegistered('integ-wh1', 'cloud-abc', 'token', null);

    // First call registers, second call is a no-op
    expect(result1.registered).toBe(true);
    expect(result2.registered).toBe(false);
    expect(result2.webhookId).toBe(101);

    // Jira API was called exactly once
    expect(axios.post).toHaveBeenCalledTimes(1);

    // Only one registration record in the DB
    const regs = [...db.webhookRegistrations.values()].filter(
      (r) => r.integrationId === 'integ-wh1'
    );
    expect(regs).toHaveLength(1);
  });
});

describe('AC: Attachment Deduplication — 5 existing + 2 new IDs', () => {
  beforeEach(() => {
    clearDb();
    axios.get.mockReset();
  });

  test('downloads binary exactly 2 times; sidecar carry-forward for 5 existing IDs', async () => {
    const { v4: uuidv4 } = require('uuid');

    // Pre-populate 5 existing manifest entries (non-sidecar, prior downloads)
    const existingIds = ['att-e1', 'att-e2', 'att-e3', 'att-e4', 'att-e5'];
    for (const id of existingIds) {
      const entry = {
        id: uuidv4(),
        integrationId: 'integ-dedup1',
        backupPointId: 'bp-prior',
        attachmentId: id,
        issueKey: 'PROJ-1',
        filename: `${id}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 100,
        binaryStorageRef: `integrations/integ-dedup1/attachments/${id}`,
        sidecarOnly: false,
        priorManifestEntryId: null,
        downloadedAt: new Date(Date.now() - 86400000).toISOString(),
        checksum: `checksum-${id}`,
      };
      db.attachmentManifestEntries.set(entry.id, entry);
    }

    // Build issues: first issue has 5 existing attachments, second has 2 new ones
    const newIds = ['att-n1', 'att-n2'];
    const issues = [
      {
        key: 'PROJ-1',
        fields: {
          attachment: existingIds.map((id) => ({
            id, filename: `${id}.pdf`, mimeType: 'application/pdf', size: 100,
          })),
        },
      },
      {
        key: 'PROJ-2',
        fields: {
          attachment: newIds.map((id) => ({
            id, filename: `${id}.txt`, mimeType: 'text/plain', size: 50,
          })),
        },
      },
    ];

    // Mock binary downloads for new IDs
    const fakeBinary = Buffer.from('new-binary-data');
    axios.get.mockResolvedValue({ data: fakeBinary.buffer });

    const entries = await processAttachments(
      'integ-dedup1', 'bp-current', issues, 'cloud-abc', makeMockJiraAxios()
    );

    // Should have 7 entries total (5 sidecar + 2 new downloads)
    expect(entries).toHaveLength(7);

    const sidecarEntries = entries.filter((e) => e.sidecarOnly === true);
    const downloadEntries = entries.filter((e) => e.sidecarOnly === false);

    expect(sidecarEntries).toHaveLength(5);
    expect(downloadEntries).toHaveLength(2);

    // Binary download called exactly 2 times (once per new ID)
    expect(axios.get).toHaveBeenCalledTimes(2);

    // Each sidecar entry must reference a prior manifest entry
    for (const sc of sidecarEntries) {
      expect(sc.priorManifestEntryId).not.toBeNull();
      expect(sc.binaryStorageRef).toBeNull();
    }

    // Each download entry must have a storage ref and checksum
    for (const dl of downloadEntries) {
      expect(dl.binaryStorageRef).toBeTruthy();
      expect(dl.checksum).toBeTruthy();
    }

    // Verify the 2 download calls targeted the new attachment IDs
    const calledUrls = axios.get.mock.calls.map((c) => c[0]);
    expect(calledUrls.some((u) => u.includes('att-n1'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('att-n2'))).toBe(true);
  });
});

describe('AC: Site-Level Enumeration runs even with empty project scope', () => {
  beforeEach(() => {
    clearDb();
    axios.get.mockReset();
    axios.post.mockReset();
  });

  test('runSiteEnumeration calls /workflow/search and /field regardless of project scope', async () => {
    // Workflows
    axios.get
      .mockResolvedValueOnce({ data: { values: [{ id: 'wf-1', name: 'WF1' }], isLast: true } })
      // Fields
      .mockResolvedValueOnce({ data: [{ id: 'cf-1', name: 'CF1', schema: { type: 'number' } }] })
      // Contexts for cf-1
      .mockResolvedValueOnce({ data: { values: [], isLast: true } });

    const result = await runSiteEnumeration('cloud-empty', makeMockJiraAxios());

    expect(result.workflows).toHaveLength(1);
    expect(result.fields).toHaveLength(1);

    // Verify the workflow/search URL was called
    const calledUrls = axios.get.mock.calls.map((c) => c[0]);
    expect(calledUrls.some((u) => u.includes('/workflow/search'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('/field'))).toBe(true);
  });

  test('runIntegrationBackup runs site enumeration even when project scope is empty set', async () => {
    const conn = makeConnection({
      projectScopeMode: 'selected',
      selectedProjectIds: [], // Empty — no projects to back up
    });

    // No project-level JQL calls needed (no projects), but site enumeration must fire.
    // workflow/search
    axios.get
      .mockResolvedValueOnce({ data: { values: [{ id: 'wf-x', name: 'WFX' }], isLast: true } })
      // /field
      .mockResolvedValueOnce({ data: [{ id: 'cf-x', name: 'CFX', schema: { type: 'number' } }] })
      // contexts for cf-x
      .mockResolvedValueOnce({ data: { values: [], isLast: true } });

    // Webhook registration
    axios.post.mockResolvedValue({
      data: { webhookRegistrationResult: [{ createdWebhookId: 200 }] },
    });

    const { runIntegrationBackup } = require('../src/services/backupEngine');
    const result = await runIntegrationBackup(conn.id);

    // No project results (empty scope)
    expect(result.projectResults).toHaveLength(0);
    // But site enumeration ran
    expect(result.siteEnumeration.workflowCount).toBe(1);
    expect(result.siteEnumeration.fieldCount).toBe(1);

    const calledUrls = axios.get.mock.calls.map((c) => c[0]);
    expect(calledUrls.some((u) => u.includes('/workflow/search'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('/field'))).toBe(true);
  });
});

describe('AC: Custom Field Context and Option Enumeration per field', () => {
  beforeEach(() => {
    clearDb();
    axios.get.mockReset();
  });

  test('/context and /context/option called for each field returned by /field', async () => {
    // Two custom fields: one select (gets options), one number (no options)
    const fields = [
      { id: 'cf-select', name: 'Priority', schema: { type: 'select' } },
      { id: 'cf-number', name: 'Points', schema: { type: 'number' } },
    ];

    // Mock /field response
    // For cf-select: context + options
    // For cf-number: context only (no options)
    axios.get
      // /field
      .mockResolvedValueOnce({ data: fields })
      // Not needed for runSiteEnumeration but we call directly:
      // contexts for cf-select
      .mockResolvedValueOnce({ data: { values: [{ id: 'ctx-sel-1', name: 'Ctx Sel', isGlobalContext: true }], isLast: true } })
      // options for cf-select ctx-sel-1
      .mockResolvedValueOnce({ data: { values: [{ id: 'opt-1', value: 'High' }, { id: 'opt-2', value: 'Low' }], isLast: true } })
      // contexts for cf-number
      .mockResolvedValueOnce({ data: { values: [{ id: 'ctx-num-1', name: 'Ctx Num', isGlobalContext: false }], isLast: true } });
    // No options call for cf-number (type=number is not in OPTION_FIELD_TYPES)

    // Call enumerateCustomFields then enumerateCustomFieldContexts for each
    const fieldResult = await enumerateCustomFields('cloud-ctx', makeMockJiraAxios());
    expect(fieldResult).toHaveLength(2);

    const ctxSelect = await enumerateCustomFieldContexts('cloud-ctx', makeMockJiraAxios(), 'cf-select', 'select');
    const ctxNumber = await enumerateCustomFieldContexts('cloud-ctx', makeMockJiraAxios(), 'cf-number', 'number');

    // select field got contexts and options
    expect(ctxSelect).toHaveLength(1);
    expect(ctxSelect[0].options).toHaveLength(2);

    // number field got contexts but no options
    expect(ctxNumber).toHaveLength(1);
    expect(ctxNumber[0].options).toHaveLength(0);

    // Total API calls: 1 (/field) + 1 (ctx select) + 1 (opt select) + 1 (ctx number) = 4
    expect(axios.get).toHaveBeenCalledTimes(4);

    // Verify /context called for each field (exact context endpoint, not /context/option)
    const calledUrls = axios.get.mock.calls.map((c) => c[0]);
    expect(calledUrls.filter((u) => /\/cf-select\/context$/.test(u))).toHaveLength(1);
    expect(calledUrls.filter((u) => /\/cf-number\/context$/.test(u))).toHaveLength(1);
    // options only for select
    expect(calledUrls.filter((u) => u.includes('/cf-select/context/option'))).toHaveLength(1);
    expect(calledUrls.filter((u) => u.includes('/cf-number/context/option'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 10. Integration Smoke Test — Full pipeline end-to-end against mock Jira API
// ---------------------------------------------------------------------------

describe('Integration Smoke Test — full pipeline end-to-end', () => {
  beforeEach(() => {
    clearDb();
    axios.get.mockReset();
    axios.post.mockReset();
  });

  test('full backup run completes without errors and returns expected structure', async () => {
    const { runIntegrationBackup } = require('../src/services/backupEngine');

    // Connection with one selected project and webhook scope
    const conn = makeConnection({
      projectScopeMode: 'selected',
      selectedProjectIds: ['SMOKE'],
      grantedScopes: ['read:jira-work', 'manage:jira-webhook'],
    });

    // Seed a project node so backupEngine can find it for selected mode
    db.projectNodes.set(`${conn.id}:SMOKE`, {
      integrationId: conn.id,
      projectKey: 'SMOKE',
      projectId: 'proj-smoke',
      name: 'Smoke Project',
      archived: false,
    });

    // Mock: webhook registration
    axios.post.mockResolvedValueOnce({
      data: { webhookRegistrationResult: [{ createdWebhookId: 777 }] },
    });

    // Mock: JQL search — single page with 3 issues, no attachments
    const smokeIssues = [
      makeIssue('SMOKE-1'),
      makeIssue('SMOKE-2'),
      makeIssue('SMOKE-3'),
    ];
    axios.get
      .mockResolvedValueOnce({
        data: { issues: smokeIssues, total: 3, startAt: 0, maxResults: 100 },
      })
      // workflow/search
      .mockResolvedValueOnce({ data: { values: [{ id: 'wf-smoke', name: 'SmokeWF' }], isLast: true } })
      // /field
      .mockResolvedValueOnce({ data: [{ id: 'cf-smoke', name: 'CF Smoke', schema: { type: 'number' } }] })
      // contexts for cf-smoke
      .mockResolvedValueOnce({ data: { values: [], isLast: true } });

    const result = await runIntegrationBackup(conn.id);

    // Structural assertions
    expect(result.integrationId).toBe(conn.id);
    expect(result.cloudId).toBe('cloud-abc');
    expect(result.completedAt).toBeTruthy();

    // Webhook was registered
    expect(result.webhookResult).not.toBeNull();
    expect(result.webhookResult.webhookId).toBe(777);
    expect(result.webhookResult.registered).toBe(true);

    // Project backup ran
    expect(result.projectResults).toHaveLength(1);
    expect(result.projectResults[0].projectKey).toBe('SMOKE');
    expect(result.projectResults[0].issues).toHaveLength(3);
    expect(result.projectResults[0].mode).toBe('full');

    // Site enumeration ran
    expect(result.siteEnumeration.workflowCount).toBe(1);
    expect(result.siteEnumeration.fieldCount).toBe(1);

    // DB consistency
    expect(db.issueNodes.has(`${conn.id}:SMOKE-1`)).toBe(true);
    expect(db.issueNodes.has(`${conn.id}:SMOKE-2`)).toBe(true);
    expect(db.issueNodes.has(`${conn.id}:SMOKE-3`)).toBe(true);
    expect(db.workflowNodes.has('cloud-abc:wf-smoke')).toBe(true);
    expect(db.customFieldDefinitions.has('cloud-abc:cf-smoke')).toBe(true);

    // BackupRunState updated
    const runStates = [...db.backupRunStates.values()].filter(
      (s) => s.integrationId === conn.id && s.projectKey === 'SMOKE'
    );
    expect(runStates).toHaveLength(1);
    expect(runStates[0].lastRunStatus).toBe('success');
    expect(runStates[0].lastBackupTimestamp).not.toBeNull();

    // Webhook stored in DB
    const webhookRegs = [...db.webhookRegistrations.values()].filter(
      (r) => r.integrationId === conn.id
    );
    expect(webhookRegs).toHaveLength(1);
    expect(webhookRegs[0].webhookId).toBe(777);

    // Connection lastSyncedAt updated
    const updatedConn = db.connections.get(conn.id);
    expect(updatedConn.lastSyncedAt).not.toBeNull();
  });

  test('smoke test: POST /api/v1/integrations/:id/backup triggers full pipeline via HTTP', async () => {
    const conn = makeConnection({
      projectScopeMode: 'all',
      selectedProjectIds: [],
      grantedScopes: ['read:jira-work', 'manage:jira-webhook'],
    });

    // No projects in all-projects mode with empty projectNodes → 0 project results
    // Webhook registration
    axios.post.mockResolvedValueOnce({
      data: { webhookRegistrationResult: [{ createdWebhookId: 888 }] },
    });
    // workflow/search
    axios.get
      .mockResolvedValueOnce({ data: { values: [], isLast: true } })
      // /field
      .mockResolvedValueOnce({ data: [] });

    const res = await request(app)
      .post(`/api/v1/integrations/${conn.id}/backup`)
      .send();

    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeTruthy();
    expect(res.body.status).toBe('running');
  });
});
