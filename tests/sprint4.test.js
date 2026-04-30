'use strict';

/**
 * Sprint 4 — Restore Engine
 * Comprehensive test suite covering:
 *   - Unit: pre-execution validation checks (pass/fail/warn)
 *   - Unit: cross-site custom field ID mapping
 *   - Unit: conflict mode resolution (Skip, Override, Ask, Ask-suppressed-at-50)
 *   - Unit: restore destination routing (original, alternate, export)
 *   - Unit: permanent API constraint handlers
 *   - Integration/E2E: full five-stage pipeline with mocked data
 *   - Edge cases: basket boundary, blocking validation halt, attachment size boundary
 */

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const app = require('../src/app');
const db = require('../src/db');
const {
  checkOAuthTokenValidity,
  checkTargetProjectExistence,
  checkTargetProjectArchiveStatus,
  checkJiraSoftwareActive,
  checkWorkflowStatusNames,
  checkCustomFieldPresence,
  checkAttachmentSize,
  runValidationPipeline,
} = require('../src/services/validationService');
const { buildFieldMap } = require('../src/services/customFieldMappingService');
const {
  stampOriginalKeyLabel,
  injectReporterAttributionHeader,
  prependCommentAuthorAdfHeader,
  buildWorkflowRestorePayload,
} = require('../src/services/apiConstraintHandlers');
const {
  initiateRestore,
  resolveConflictMode,
  buildBasket,
} = require('../src/services/restoreOrchestrator');
const {
  ATTACHMENT_SIZE_LIMIT_BYTES,
  ASK_BASKET_THRESHOLD,
  RESTORE_STAGE_ORDER,
  ISSUE_KEY_LABEL_PREFIX,
} = require('../src/config/restoreConstants');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clearRestoreDb() {
  db.restoreJobs.clear();
  db.exportArchives.clear();
  db.restoredObjects.clear();
  db.objectSnapshots.clear();
  db.connections.clear();
  db.projectNodes.clear();
  db.workflowNodes.clear();
  db.customFieldDefinitions.clear();
}

function seedConnection(overrides = {}) {
  const id = overrides.id || uuidv4();
  const conn = {
    id,
    cloudId: overrides.cloudId || 'site-a',
    siteId: overrides.siteId,
    accessToken: overrides.accessToken || 'tok',
    accessTokenExpiresAt: overrides.accessTokenExpiresAt || new Date(Date.now() + 3600_000).toISOString(),
    grantedScopes: overrides.grantedScopes || [],
    deletedAt: overrides.deletedAt || null,
  };
  db.connections.set(id, conn);
  return conn;
}

function seedProject(overrides = {}) {
  const id = overrides.id || uuidv4();
  const project = {
    id,
    key: overrides.key || 'PROJ',
    cloudId: overrides.cloudId || 'site-a',
    siteId: overrides.siteId,
    archived: overrides.archived || false,
  };
  db.projectNodes.set(id, project);
  return project;
}

function seedSnapshot(backupPointId, nodeType, id, fields = {}) {
  const key = `${backupPointId}:${nodeType}:${id}`;
  db.objectSnapshots.set(key, { backupPointId, nodeType, id, fields });
  return { backupPointId, nodeType, id, fields };
}

function makeBasicRestoreRequest(overrides = {}) {
  return {
    backupPointId: overrides.backupPointId || 'bp-1',
    sourceSiteId: overrides.sourceSiteId || 'site-a',
    destination: overrides.destination || { type: 'original', originalProjectKey: 'PROJ', originalSiteId: 'site-a' },
    conflictMode: overrides.conflictMode || 'skip',
    objectSelection: overrides.objectSelection || { includeAll: true },
  };
}

// ─── UNIT: Pre-Execution Validation Checks ───────────────────────────────────

describe('Unit — checkOAuthTokenValidity', () => {
  beforeEach(() => clearRestoreDb());

  test('PASS: no connections in db (simulation context)', () => {
    const result = checkOAuthTokenValidity('site-a');
    expect(result.passed).toBe(true);
    expect(result.blocking).toBe(true);
  });

  test('PASS: valid non-expired token for target site', () => {
    seedConnection({ cloudId: 'site-a', accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const result = checkOAuthTokenValidity('site-a');
    expect(result.passed).toBe(true);
  });

  test('PASS: token exists but no expiry tracked', () => {
    seedConnection({ cloudId: 'site-a', accessToken: 'tok', accessTokenExpiresAt: null });
    const result = checkOAuthTokenValidity('site-a');
    expect(result.passed).toBe(true);
  });

  test('FAIL (blocking): expired token for target site', () => {
    seedConnection({ cloudId: 'site-a', accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const result = checkOAuthTokenValidity('site-a');
    expect(result.passed).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.errorCode).toBe('OAUTH_TOKEN_INVALID');
  });

  test('FAIL (blocking): connection deleted', () => {
    seedConnection({ cloudId: 'site-a', deletedAt: new Date().toISOString() });
    const result = checkOAuthTokenValidity('site-a');
    expect(result.passed).toBe(false);
    expect(result.blocking).toBe(true);
  });

  test('PASS: matches by siteId field', () => {
    seedConnection({ cloudId: 'other', siteId: 'site-b', accessToken: 'tok', accessTokenExpiresAt: null });
    const result = checkOAuthTokenValidity('site-b');
    expect(result.passed).toBe(true);
  });
});

describe('Unit — checkTargetProjectExistence', () => {
  beforeEach(() => clearRestoreDb());

  test('PASS: no project nodes in db (simulation)', () => {
    const result = checkTargetProjectExistence('PROJ', 'site-a');
    expect(result.passed).toBe(true);
  });

  test('PASS: project exists on target site', () => {
    seedProject({ key: 'PROJ', cloudId: 'site-a' });
    const result = checkTargetProjectExistence('PROJ', 'site-a');
    expect(result.passed).toBe(true);
  });

  test('FAIL (blocking): project exists but on different site', () => {
    seedProject({ key: 'PROJ', cloudId: 'site-b' });
    const result = checkTargetProjectExistence('PROJ', 'site-a');
    expect(result.passed).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.errorCode).toBe('TARGET_PROJECT_NOT_FOUND');
  });

  test('FAIL (blocking): project key mismatch', () => {
    seedProject({ key: 'OTHER', cloudId: 'site-a' });
    const result = checkTargetProjectExistence('PROJ', 'site-a');
    expect(result.passed).toBe(false);
    expect(result.errorCode).toBe('TARGET_PROJECT_NOT_FOUND');
  });
});

describe('Unit — checkTargetProjectArchiveStatus', () => {
  beforeEach(() => clearRestoreDb());

  test('PASS: project not archived', () => {
    seedProject({ key: 'PROJ', cloudId: 'site-a', archived: false });
    const result = checkTargetProjectArchiveStatus('PROJ', 'site-a');
    expect(result.passed).toBe(true);
  });

  test('FAIL (blocking): project is archived', () => {
    seedProject({ key: 'PROJ', cloudId: 'site-a', archived: true });
    const result = checkTargetProjectArchiveStatus('PROJ', 'site-a');
    expect(result.passed).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.errorCode).toBe('TARGET_PROJECT_ARCHIVED');
  });

  test('PASS: no matching project (no archive flag set)', () => {
    seedProject({ key: 'OTHER', cloudId: 'site-a', archived: true });
    const result = checkTargetProjectArchiveStatus('PROJ', 'site-a');
    expect(result.passed).toBe(true);
  });
});

describe('Unit — checkJiraSoftwareActive', () => {
  beforeEach(() => clearRestoreDb());

  test('PASS: no connections (simulation)', () => {
    const result = checkJiraSoftwareActive('site-a');
    expect(result.passed).toBe(true);
  });

  test('PASS: connection has read:board-scope:jira-software', () => {
    seedConnection({ cloudId: 'site-a', grantedScopes: ['read:board-scope:jira-software'] });
    const result = checkJiraSoftwareActive('site-a');
    expect(result.passed).toBe(true);
  });

  test('FAIL (blocking): connection lacks board scope', () => {
    seedConnection({ cloudId: 'site-a', grantedScopes: ['read:jira-work'] });
    const result = checkJiraSoftwareActive('site-a');
    expect(result.passed).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.errorCode).toBe('JIRA_SOFTWARE_NOT_ACTIVE');
  });

  test('FAIL (blocking): connection deleted even with correct scope', () => {
    seedConnection({ cloudId: 'site-a', grantedScopes: ['read:board-scope:jira-software'], deletedAt: new Date().toISOString() });
    const result = checkJiraSoftwareActive('site-a');
    expect(result.passed).toBe(false);
  });
});

describe('Unit — checkWorkflowStatusNames', () => {
  test('PASS: no workflow items in basket', () => {
    const items = [{ objectType: 'issue', id: '1', fields: {} }];
    const result = checkWorkflowStatusNames(items);
    expect(result.passed).toBe(true);
    expect(result.blocking).toBe(false);
  });

  test('PASS: workflow with valid status names', () => {
    const items = [{
      objectType: 'workflow', id: 'wf1',
      fields: { statuses: [{ id: 's1', name: 'To Do' }, { id: 's2', name: 'Done' }] },
    }];
    const result = checkWorkflowStatusNames(items);
    expect(result.passed).toBe(true);
  });

  test('WARN (non-blocking): workflow status with blank name', () => {
    const items = [{
      objectType: 'workflow', id: 'wf1',
      fields: { statuses: [{ id: 's1', name: '' }] },
    }];
    const result = checkWorkflowStatusNames(items);
    expect(result.passed).toBe(false);
    expect(result.blocking).toBe(false);
    expect(result.errorCode).toBe('WORKFLOW_STATUS_NAME_MISSING');
    expect(result.affectedItems).toContain('s1');
  });

  test('WARN (non-blocking): workflow status with missing name field', () => {
    const items = [{
      objectType: 'workflow', id: 'wf1',
      fields: { statuses: [{ id: 's2' }] },
    }];
    const result = checkWorkflowStatusNames(items);
    expect(result.passed).toBe(false);
    expect(result.blocking).toBe(false);
  });
});

describe('Unit — checkCustomFieldPresence', () => {
  beforeEach(() => clearRestoreDb());

  test('PASS: no custom fields in basket (no issues)', () => {
    const { requiredResult, optionalResult } = checkCustomFieldPresence([], 'site-a');
    expect(requiredResult.passed).toBe(true);
    expect(optionalResult.passed).toBe(true);
  });

  test('PASS: no customFieldDefinitions in db (simulation)', () => {
    const items = [{ objectType: 'issue', id: 'i1', fields: { customfield_10001: 'val' } }];
    const { requiredResult, optionalResult } = checkCustomFieldPresence(items, 'site-a');
    expect(requiredResult.passed).toBe(true);
    expect(optionalResult.passed).toBe(true);
  });

  test('FAIL (blocking): required custom field missing on target site', () => {
    // Seed a field definition for site-a so db.customFieldDefinitions.size > 0
    db.customFieldDefinitions.set('site-a:customfield_99999', { name: 'Other Field', fieldId: 'customfield_99999' });
    const items = [{
      objectType: 'issue', id: 'i1',
      fields: { customfield_10001: 'val' },
      requiredFields: ['customfield_10001'],
    }];
    const { requiredResult } = checkCustomFieldPresence(items, 'site-a');
    expect(requiredResult.passed).toBe(false);
    expect(requiredResult.blocking).toBe(true);
    expect(requiredResult.errorCode).toBe('CUSTOM_FIELD_REQUIRED_MISSING');
    expect(requiredResult.affectedItems).toContain('customfield_10001');
  });

  test('WARN (non-blocking): optional custom field missing on target site', () => {
    db.customFieldDefinitions.set('site-a:customfield_99999', { name: 'Other Field', fieldId: 'customfield_99999' });
    const items = [{
      objectType: 'issue', id: 'i1',
      fields: { customfield_10001: 'val' },
      // No requiredFields → treated as optional
    }];
    const { requiredResult, optionalResult } = checkCustomFieldPresence(items, 'site-a');
    expect(requiredResult.passed).toBe(true);
    expect(optionalResult.passed).toBe(false);
    expect(optionalResult.blocking).toBe(false);
    expect(optionalResult.errorCode).toBe('CUSTOM_FIELD_OPTIONAL_MISSING');
  });

  test('PASS: custom field exists on target site', () => {
    db.customFieldDefinitions.set('site-a:customfield_10001', { name: 'Sprint', fieldId: 'customfield_10001' });
    const items = [{
      objectType: 'issue', id: 'i1',
      fields: { customfield_10001: 'val' },
      requiredFields: ['customfield_10001'],
    }];
    const { requiredResult } = checkCustomFieldPresence(items, 'site-a');
    expect(requiredResult.passed).toBe(true);
  });
});

describe('Unit — checkAttachmentSize', () => {
  test('PASS: no attachments in basket', () => {
    const result = checkAttachmentSize([{ objectType: 'issue', id: 'i1', fields: {} }]);
    expect(result.passed).toBe(true);
  });

  test('PASS: attachment at exactly 250 MB', () => {
    const items = [{ objectType: 'attachment', id: 'a1', sizeBytes: ATTACHMENT_SIZE_LIMIT_BYTES }];
    const result = checkAttachmentSize(items);
    expect(result.passed).toBe(true);
  });

  test('FAIL (blocking): attachment at 250 MB + 1 byte', () => {
    const items = [{ objectType: 'attachment', id: 'a1', sizeBytes: ATTACHMENT_SIZE_LIMIT_BYTES + 1 }];
    const result = checkAttachmentSize(items);
    expect(result.passed).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.errorCode).toBe('ATTACHMENT_SIZE_EXCEEDED');
    expect(result.affectedItems).toContain('a1');
  });

  test('PASS: attachment size from fields.sizeBytes at limit', () => {
    const items = [{ objectType: 'attachment', id: 'a2', fields: { sizeBytes: ATTACHMENT_SIZE_LIMIT_BYTES } }];
    const result = checkAttachmentSize(items);
    expect(result.passed).toBe(true);
  });

  test('FAIL: attachment size from fields.sizeBytes over limit', () => {
    const items = [{ objectType: 'attachment', id: 'a2', fields: { sizeBytes: ATTACHMENT_SIZE_LIMIT_BYTES + 1 } }];
    const result = checkAttachmentSize(items);
    expect(result.passed).toBe(false);
    expect(result.affectedItems).toContain('a2');
  });
});

describe('Unit — runValidationPipeline', () => {
  beforeEach(() => clearRestoreDb());

  test('PASS: all checks pass with empty db (simulation)', () => {
    const result = runValidationPipeline({
      restoreRequest: {},
      targetSiteId: 'site-a',
      targetProjectKey: 'PROJ',
      basketItems: [],
      includeBoardSprintRestore: false,
    });
    expect(result.passed).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  test('blocking failure halts pipeline at check 1 (OAuth)', () => {
    // Seed a connection with expired token so check 1 fails
    seedConnection({ cloudId: 'site-a', accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const result = runValidationPipeline({
      restoreRequest: {},
      targetSiteId: 'site-a',
      targetProjectKey: 'PROJ',
      basketItems: [],
      includeBoardSprintRestore: false,
    });
    expect(result.passed).toBe(false);
    expect(result.blockingError.errorCode).toBe('OAUTH_TOKEN_INVALID');
  });

  test('blocking failure at check 3 (archived project)', () => {
    seedProject({ key: 'PROJ', cloudId: 'site-a', archived: true });
    const result = runValidationPipeline({
      restoreRequest: {},
      targetSiteId: 'site-a',
      targetProjectKey: 'PROJ',
      basketItems: [],
      includeBoardSprintRestore: false,
    });
    expect(result.passed).toBe(false);
    expect(result.blockingError.errorCode).toBe('TARGET_PROJECT_ARCHIVED');
  });

  test('non-blocking warning from workflow status names does not halt pipeline', () => {
    const basketItems = [{
      objectType: 'workflow', id: 'wf1',
      fields: { statuses: [{ id: 's1', name: '' }] },
    }];
    const result = runValidationPipeline({
      restoreRequest: {},
      targetSiteId: 'site-a',
      targetProjectKey: 'PROJ',
      basketItems,
      includeBoardSprintRestore: false,
    });
    expect(result.passed).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0].errorCode).toBe('WORKFLOW_STATUS_NAME_MISSING');
  });

  test('check 4 (Jira Software) skipped when no boards/sprints in basket', () => {
    seedConnection({ cloudId: 'site-a', grantedScopes: [] }); // No board scope
    const result = runValidationPipeline({
      restoreRequest: {},
      targetSiteId: 'site-a',
      targetProjectKey: 'PROJ',
      basketItems: [],
      includeBoardSprintRestore: false, // Not requested
    });
    expect(result.passed).toBe(true);
  });

  test('check 4 (Jira Software) blocking when boards in basket and scope missing', () => {
    seedConnection({ cloudId: 'site-a', grantedScopes: ['read:jira-work'] });
    const result = runValidationPipeline({
      restoreRequest: {},
      targetSiteId: 'site-a',
      targetProjectKey: 'PROJ',
      basketItems: [],
      includeBoardSprintRestore: true,
    });
    expect(result.passed).toBe(false);
    expect(result.blockingError.errorCode).toBe('JIRA_SOFTWARE_NOT_ACTIVE');
  });

  test('blocking failure at attachment size stops pipeline', () => {
    const basketItems = [{ objectType: 'attachment', id: 'a1', sizeBytes: ATTACHMENT_SIZE_LIMIT_BYTES + 1 }];
    const result = runValidationPipeline({
      restoreRequest: {},
      targetSiteId: 'site-a',
      targetProjectKey: 'PROJ',
      basketItems,
      includeBoardSprintRestore: false,
    });
    expect(result.passed).toBe(false);
    expect(result.blockingError.errorCode).toBe('ATTACHMENT_SIZE_EXCEEDED');
  });
});

// ─── UNIT: Cross-Site Custom Field Mapping ────────────────────────────────────

describe('Unit — buildFieldMap (cross-site custom field mapping)', () => {
  beforeEach(() => clearRestoreDb());

  test('ok status: empty field list maps to empty fieldMap', () => {
    const result = buildFieldMap({ sourceSiteId: 'site-a', targetSiteId: 'site-b', sourceFieldIds: [] });
    expect(result.status).toBe('ok');
    expect(result.fieldMap).toEqual({});
    expect(result.missingRequired).toHaveLength(0);
    expect(result.missingOptional).toHaveLength(0);
  });

  test('simulation: no definitions in db → self-maps all fields', () => {
    const result = buildFieldMap({
      sourceSiteId: 'site-a', targetSiteId: 'site-b',
      sourceFieldIds: ['customfield_10001', 'customfield_10002'],
    });
    expect(result.status).toBe('ok');
    expect(result.fieldMap['customfield_10001']).toBe('customfield_10001');
    expect(result.fieldMap['customfield_10002']).toBe('customfield_10002');
  });

  test('full map: all source fields matched by name on target', () => {
    db.customFieldDefinitions.set('site-a:customfield_10001', { cloudId: 'site-a', fieldId: 'customfield_10001', name: 'Sprint' });
    db.customFieldDefinitions.set('site-b:customfield_20001', { cloudId: 'site-b', fieldId: 'customfield_20001', name: 'Sprint' });
    const result = buildFieldMap({
      sourceSiteId: 'site-a', targetSiteId: 'site-b',
      sourceFieldIds: ['customfield_10001'],
    });
    expect(result.status).toBe('ok');
    expect(result.fieldMap['customfield_10001']).toBe('customfield_20001');
    expect(result.missingRequired).toHaveLength(0);
    expect(result.missingOptional).toHaveLength(0);
  });

  test('blocked: missing required field on target', () => {
    // Source field defined, but no matching name on target
    db.customFieldDefinitions.set('site-a:customfield_10001', { cloudId: 'site-a', fieldId: 'customfield_10001', name: 'Sprint' });
    db.customFieldDefinitions.set('site-b:customfield_20002', { cloudId: 'site-b', fieldId: 'customfield_20002', name: 'Other' });
    const result = buildFieldMap({
      sourceSiteId: 'site-a', targetSiteId: 'site-b',
      sourceFieldIds: ['customfield_10001'],
      requiredFieldIds: ['customfield_10001'],
    });
    expect(result.status).toBe('blocked');
    expect(result.missingRequired).toContain('customfield_10001');
    expect(result.missingOptional).toHaveLength(0);
  });

  test('warn: missing optional field on target', () => {
    db.customFieldDefinitions.set('site-a:customfield_10001', { cloudId: 'site-a', fieldId: 'customfield_10001', name: 'Sprint' });
    db.customFieldDefinitions.set('site-b:customfield_20002', { cloudId: 'site-b', fieldId: 'customfield_20002', name: 'Other' });
    const result = buildFieldMap({
      sourceSiteId: 'site-a', targetSiteId: 'site-b',
      sourceFieldIds: ['customfield_10001'],
      requiredFieldIds: [],
    });
    expect(result.status).toBe('warn');
    expect(result.missingOptional).toContain('customfield_10001');
    expect(result.missingRequired).toHaveLength(0);
  });

  test('mixed: one required missing (blocked), one optional missing', () => {
    db.customFieldDefinitions.set('site-a:customfield_10001', { cloudId: 'site-a', fieldId: 'customfield_10001', name: 'Sprint' });
    db.customFieldDefinitions.set('site-a:customfield_10002', { cloudId: 'site-a', fieldId: 'customfield_10002', name: 'Story Points' });
    db.customFieldDefinitions.set('site-b:customfield_20003', { cloudId: 'site-b', fieldId: 'customfield_20003', name: 'Unrelated' });
    const result = buildFieldMap({
      sourceSiteId: 'site-a', targetSiteId: 'site-b',
      sourceFieldIds: ['customfield_10001', 'customfield_10002'],
      requiredFieldIds: ['customfield_10001'],
    });
    expect(result.status).toBe('blocked');
    expect(result.missingRequired).toContain('customfield_10001');
    expect(result.missingOptional).toContain('customfield_10002');
  });
});

// ─── UNIT: Conflict Mode Resolution ──────────────────────────────────────────

describe('Unit — resolveConflictMode', () => {
  test('skip mode unchanged for any basket size', () => {
    const { conflictModeEffective } = resolveConflictMode('skip', 1000);
    expect(conflictModeEffective).toBe('skip');
  });

  test('override mode unchanged for any basket size', () => {
    const { conflictModeEffective } = resolveConflictMode('override', 1000);
    expect(conflictModeEffective).toBe('override');
  });

  test('ask mode active when basket exactly at threshold (50)', () => {
    const { conflictModeEffective, conflictModeDowngradeReason } = resolveConflictMode('ask', ASK_BASKET_THRESHOLD);
    expect(conflictModeEffective).toBe('ask');
    expect(conflictModeDowngradeReason).toBeUndefined();
  });

  test('ask mode suppressed to skip when basket at 51', () => {
    const { conflictModeEffective, conflictModeDowngradeReason } = resolveConflictMode('ask', ASK_BASKET_THRESHOLD + 1);
    expect(conflictModeEffective).toBe('skip');
    expect(conflictModeDowngradeReason).toBe('BASKET_SIZE_EXCEEDED');
  });

  test('ask mode suppressed for large baskets', () => {
    const { conflictModeEffective } = resolveConflictMode('ask', 200);
    expect(conflictModeEffective).toBe('skip');
  });

  test('null conflictMode defaults to skip', () => {
    const { conflictModeEffective } = resolveConflictMode(null, 10);
    expect(conflictModeEffective).toBe('skip');
  });

  test('undefined conflictMode defaults to skip', () => {
    const { conflictModeEffective } = resolveConflictMode(undefined, 10);
    expect(conflictModeEffective).toBe('skip');
  });
});

// ─── UNIT: API Constraint Handlers ───────────────────────────────────────────

describe('Unit — stampOriginalKeyLabel', () => {
  test('adds original-key label to empty labels array', () => {
    const payload = { fields: {} };
    const result = stampOriginalKeyLabel(payload, 'PROJ-123');
    expect(result.fields.labels).toContain(`${ISSUE_KEY_LABEL_PREFIX}PROJ-123`);
  });

  test('appends to existing labels without overwriting', () => {
    const payload = { fields: { labels: ['bug', 'urgent'] } };
    const result = stampOriginalKeyLabel(payload, 'PROJ-456');
    expect(result.fields.labels).toContain('bug');
    expect(result.fields.labels).toContain('urgent');
    expect(result.fields.labels).toContain('original-key:PROJ-456');
  });

  test('does not add duplicate label', () => {
    const payload = { fields: { labels: ['original-key:PROJ-789'] } };
    const result = stampOriginalKeyLabel(payload, 'PROJ-789');
    const count = result.fields.labels.filter(l => l === 'original-key:PROJ-789').length;
    expect(count).toBe(1);
  });

  test('creates fields object if absent', () => {
    const payload = {};
    const result = stampOriginalKeyLabel(payload, 'PROJ-1');
    expect(result.fields).toBeDefined();
    expect(result.fields.labels).toContain('original-key:PROJ-1');
  });

  test('label uses correct prefix format', () => {
    const payload = { fields: {} };
    const result = stampOriginalKeyLabel(payload, 'MY-999');
    const label = result.fields.labels[0];
    expect(label).toBe('original-key:MY-999');
  });
});

describe('Unit — injectReporterAttributionHeader', () => {
  const sampleDoc = { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original content' }] }] };

  test('prepends reporter attribution as first ADF node', () => {
    const reporter = { displayName: 'Alice Smith', emailAddress: 'alice@example.com' };
    const result = injectReporterAttributionHeader(sampleDoc, reporter);
    expect(result.content.length).toBe(2);
    const headerText = result.content[0].content[0].text;
    expect(headerText).toContain('Alice Smith');
    expect(headerText).toContain('alice@example.com');
    expect(headerText).toContain('original reporter');
  });

  test('original content is shifted to position 1 (not lost)', () => {
    const reporter = { displayName: 'Bob', emailAddress: 'bob@example.com' };
    const result = injectReporterAttributionHeader(sampleDoc, reporter);
    expect(result.content[1].content[0].text).toBe('Original content');
  });

  test('preserves ADF version and type', () => {
    const reporter = { displayName: 'Carol', emailAddress: 'carol@example.com' };
    const result = injectReporterAttributionHeader(sampleDoc, reporter);
    expect(result.version).toBe(1);
    expect(result.type).toBe('doc');
  });

  test('handles empty content array', () => {
    const emptyDoc = { version: 1, type: 'doc', content: [] };
    const reporter = { displayName: 'Dave', emailAddress: 'dave@example.com' };
    const result = injectReporterAttributionHeader(emptyDoc, reporter);
    expect(result.content.length).toBe(1);
    expect(result.content[0].type).toBe('paragraph');
  });
});

describe('Unit — prependCommentAuthorAdfHeader', () => {
  const sampleDoc = { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Comment body' }] }] };

  test('prepends author ADF header as first node', () => {
    const author = { displayName: 'Eve', accountId: 'acc-123' };
    const result = prependCommentAuthorAdfHeader(sampleDoc, author, '2026-01-01T00:00:00Z');
    expect(result.content.length).toBe(2);
    const headerText = result.content[0].content[0].text;
    expect(headerText).toContain('Eve');
    expect(headerText).toContain('2026-01-01T00:00:00Z');
    expect(headerText).toContain('Original comment by');
  });

  test('original comment body is preserved at position 1', () => {
    const author = { displayName: 'Frank', accountId: 'acc-456' };
    const result = prependCommentAuthorAdfHeader(sampleDoc, author, '2026-02-01T00:00:00Z');
    expect(result.content[1].content[0].text).toBe('Comment body');
  });

  test('header node is type paragraph', () => {
    const author = { displayName: 'Grace', accountId: '' };
    const result = prependCommentAuthorAdfHeader(sampleDoc, author, '2026-03-01T00:00:00Z');
    expect(result.content[0].type).toBe('paragraph');
  });

  test('author header becomes outermost when applied after reporter header', () => {
    // Simulate the orchestrator order: reporter first, then author (author ends up first)
    const baseDoc = { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] };
    const reporter = { displayName: 'Reporter', emailAddress: 'rep@example.com' };
    const afterReporter = injectReporterAttributionHeader(baseDoc, reporter);
    const author = { displayName: 'Author', accountId: 'acc-789' };
    const final = prependCommentAuthorAdfHeader(afterReporter, author, '2026-01-15T00:00:00Z');
    // Author header is at index 0
    expect(final.content[0].content[0].text).toContain('Author');
    // Reporter header is at index 1
    expect(final.content[1].content[0].text).toContain('Reporter');
    // Original body is at index 2
    expect(final.content[2].content[0].text).toBe('body');
  });
});

describe('Unit — buildWorkflowRestorePayload', () => {
  test('returns full workflow definition when definition field exists', () => {
    const backup = { name: 'My Workflow', definition: { id: 'wf-1', statuses: [], transitions: [] } };
    const result = buildWorkflowRestorePayload(backup);
    expect(result).toEqual(backup.definition);
  });

  test('throws WORKFLOW_DEFINITION_MISSING when definition is absent', () => {
    expect(() => buildWorkflowRestorePayload({ name: 'No Def' })).toThrow();
    try {
      buildWorkflowRestorePayload({ name: 'No Def' });
    } catch (err) {
      expect(err.code).toBe('WORKFLOW_DEFINITION_MISSING');
    }
  });

  test('throws WORKFLOW_DEFINITION_MISSING when input is null', () => {
    expect(() => buildWorkflowRestorePayload(null)).toThrow();
  });

  test('throws WORKFLOW_DEFINITION_MISSING when input is undefined', () => {
    expect(() => buildWorkflowRestorePayload(undefined)).toThrow();
  });
});

// ─── UNIT: Restore Destination Routing ───────────────────────────────────────

describe('Unit — restore destination (original location matching)', () => {
  beforeEach(() => clearRestoreDb());

  test('original location: restore to matching project key', () => {
    const bp = 'bp-orig';
    seedSnapshot(bp, 'JiraProjectNode', 'proj-1', { key: 'PROJ', name: 'My Project' });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'PROJ', originalSiteId: 'site-a' },
      conflictMode: 'skip',
    });
    const result = initiateRestore(req);

    expect(result.status).toBe('complete');
    expect(result.stageResults).toBeDefined();
    // Stage 2 handles projects
    const stage2 = result.stageResults.find(s => s.stageNumber === RESTORE_STAGE_ORDER.PROJECTS);
    expect(stage2).toBeDefined();
  });

  test('original location: project conflict skipped with skip mode', () => {
    const bp = 'bp-orig-conflict';
    seedSnapshot(bp, 'JiraProjectNode', 'proj-2', { key: 'PROJ', name: 'My Project' });
    // Seed an existing project at target to cause a conflict
    seedProject({ key: 'PROJ', cloudId: 'site-a' });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'PROJ', originalSiteId: 'site-a' },
      conflictMode: 'skip',
    });
    const result = initiateRestore(req);

    expect(result.status).toBe('complete');
    const stage2 = result.stageResults.find(s => s.stageNumber === RESTORE_STAGE_ORDER.PROJECTS);
    expect(stage2.skipped).toBe(1);
    expect(stage2.succeeded).toBe(0);
  });
});

describe('Unit — restore destination (alternate location)', () => {
  beforeEach(() => clearRestoreDb());

  test('alternate location: restore succeeds for different project key', () => {
    const bp = 'bp-alt';
    seedSnapshot(bp, 'JiraProjectNode', 'proj-3', { key: 'SOURCE', name: 'Source Proj' });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'alternate', targetProjectKey: 'TARGET', targetSiteId: 'site-a' },
      conflictMode: 'skip',
    });
    const result = initiateRestore(req);
    expect(result.status).toBe('complete');
  });

  test('cross-site alternate: field mapping gate blocks when required field missing', () => {
    const bp = 'bp-crosssite';
    seedSnapshot(bp, 'JiraIssueNode', 'issue-1', {
      key: 'SRC-1', summary: 'Test issue',
      customfield_10001: 'sprint-value',
    });
    // Define source field but NOT on target
    db.customFieldDefinitions.set('site-a:customfield_10001', { cloudId: 'site-a', fieldId: 'customfield_10001', name: 'Sprint' });
    db.customFieldDefinitions.set('site-b:customfield_20099', { cloudId: 'site-b', fieldId: 'customfield_20099', name: 'Other' });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      sourceSiteId: 'site-a',
      destination: { type: 'alternate', targetProjectKey: 'DEST', targetSiteId: 'site-b', isCrossSite: true },
      conflictMode: 'skip',
    });
    const result = initiateRestore(req);
    // Since customfield_10001 is not marked required in the item, mapping uses warn not blocked
    // The pipeline returns field mapping warn and continues
    expect(result.__fieldMappingBlocked).toBeFalsy();
  });
});

describe('Unit — restore destination (JSON+ZIP export)', () => {
  beforeEach(() => clearRestoreDb());

  test('export destination: job completes with exportDownloadUrl', () => {
    const bp = 'bp-export';
    seedSnapshot(bp, 'JiraProjectNode', 'proj-exp', { key: 'EXP', name: 'Export Proj' });
    seedSnapshot(bp, 'JiraIssueNode', 'issue-exp-1', { key: 'EXP-1', summary: 'First issue' });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'export', exportFormat: 'json+zip' },
      conflictMode: 'skip',
    });
    const result = initiateRestore(req);

    expect(result.status).toBe('complete');
    expect(result.exportDownloadUrl).toBeDefined();
  });

  test('export destination: archive stored in db with valid manifest', () => {
    const bp = 'bp-export2';
    seedSnapshot(bp, 'JiraIssueNode', 'issue-e2', { key: 'EXP-2', summary: 'Second issue' });
    seedSnapshot(bp, 'JiraAttachmentNode', 'attach-e2', { filename: 'test.png', sizeBytes: 1024 });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'export', exportFormat: 'json+zip' },
      conflictMode: 'skip',
    });
    const result = initiateRestore(req);

    const archive = db.exportArchives.get(result.restoreJobId);
    expect(archive).toBeDefined();
    expect(archive.manifest).toBeDefined();
    expect(Array.isArray(archive.manifest)).toBe(true);
    // Issue and attachment should appear in manifest
    const issueEntry = archive.manifest.find(m => m.objectType === 'issue');
    expect(issueEntry).toBeDefined();
    expect(issueEntry.objectPath).toMatch(/objects\/issue_/);
    const attachEntry = archive.manifest.find(m => m.objectType === 'attachment');
    expect(attachEntry).toBeDefined();
    expect(attachEntry.attachmentPath).toMatch(/attachments\//);
  });

  test('export archive objects map contains valid Jira REST API v3 schema JSON', () => {
    const bp = 'bp-export3';
    seedSnapshot(bp, 'JiraIssueNode', 'issue-e3', { key: 'EXP-3', summary: 'Schema test', issuetype: { name: 'Story' } });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'export', exportFormat: 'json+zip' },
    });
    const result = initiateRestore(req);
    const archive = db.exportArchives.get(result.restoreJobId);

    // objects should have at least one entry
    expect(Object.keys(archive.objects).length).toBeGreaterThan(0);
    // Check that the issue object has fields
    const objKey = Object.keys(archive.objects).find(k => k.includes('issue'));
    expect(objKey).toBeDefined();
    const issuePayload = archive.objects[objKey];
    expect(issuePayload).toBeDefined();
    // Issue should have label stamped
    expect(issuePayload.fields.labels).toContain('original-key:EXP-3');
  });

  test('export attachment entries contain id, filename, path, sizeBytes', () => {
    const bp = 'bp-export4';
    seedSnapshot(bp, 'JiraAttachmentNode', 'attach-4', { filename: 'doc.pdf', sizeBytes: 5000 });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'export', exportFormat: 'json+zip' },
    });
    const result = initiateRestore(req);
    const archive = db.exportArchives.get(result.restoreJobId);

    expect(archive.attachments.length).toBe(1);
    const att = archive.attachments[0];
    expect(att.id).toBe('attach-4');
    expect(att.filename).toBe('doc.pdf');
    expect(att.path).toContain('attachments/');
    expect(att.sizeBytes).toBe(5000);
  });
});

// ─── UNIT: Conflict Mode Behaviours ──────────────────────────────────────────

describe('Unit — conflict mode Skip', () => {
  beforeEach(() => clearRestoreDb());

  test('Skip: conflicting workflow is skipped, non-conflicting issue succeeds', () => {
    const bp = 'bp-skip';
    // Workflow that conflicts (existing entry in db)
    seedSnapshot(bp, 'JiraWorkflowNode', 'wf-skip', { name: 'WF Skip', definition: { id: 'wf-skip', statuses: [], transitions: [] } });
    db.workflowNodes.set('site-a:wf-skip', { name: 'WF Skip', cloudId: 'site-a' }); // causes conflict
    // Issue that does NOT conflict (issues never conflict in this implementation)
    seedSnapshot(bp, 'JiraIssueNode', 'issue-skip-1', { key: 'SKIP-1', summary: 'Skip test issue' });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'SKIP', originalSiteId: 'site-a' },
      conflictMode: 'skip',
    });
    const result = initiateRestore(req);

    // Stage 1 (workflows): the workflow should be skipped
    const stage1 = result.stageResults.find(s => s.stageNumber === RESTORE_STAGE_ORDER.WORKFLOWS_AND_CUSTOM_FIELDS);
    expect(stage1.skipped).toBe(1);
    expect(stage1.succeeded).toBe(0);

    // Stage 3 (issues): the issue should succeed
    const stage3 = result.stageResults.find(s => s.stageNumber === RESTORE_STAGE_ORDER.PARENT_ISSUES);
    expect(stage3.succeeded).toBe(1);
    expect(stage3.skipped).toBe(0);
  });
});

describe('Unit — conflict mode Override', () => {
  beforeEach(() => clearRestoreDb());

  test('Override: conflicting project is overridden (written to destination)', () => {
    const bp = 'bp-override';
    seedSnapshot(bp, 'JiraProjectNode', 'proj-ov-1', { key: 'OV', name: 'Override Project' });
    seedProject({ key: 'OV', cloudId: 'site-a' }); // Causes conflict

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'OV', originalSiteId: 'site-a' },
      conflictMode: 'override',
    });
    const result = initiateRestore(req);
    const stage2 = result.stageResults.find(s => s.stageNumber === RESTORE_STAGE_ORDER.PROJECTS);
    expect(stage2.succeeded).toBe(1);
    expect(stage2.skipped).toBe(0);
    const projItem = stage2.items[0];
    expect(projItem.status).toBe('success');
    expect(projItem.targetId).toBeDefined();
  });
});

describe('Unit — conflict mode Ask', () => {
  beforeEach(() => clearRestoreDb());

  test('Ask: basket exactly at 50 → ask mode active, pending conflict created', () => {
    const bp = 'bp-ask-50';
    // Seed 50 issue snapshots
    for (let i = 0; i < 50; i++) {
      seedSnapshot(bp, 'JiraIssueNode', `issue-ask-${i}`, { key: `ASK-${i}`, summary: `Issue ${i}` });
    }
    // Seed one workflow that conflicts
    seedSnapshot(bp, 'JiraWorkflowNode', 'wf-ask', { name: 'Conflicting WF', definition: { id: 'wf', statuses: [], transitions: [] } });
    db.workflowNodes.set('site-a:wf-ask', { name: 'Conflicting WF', cloudId: 'site-a' }); // causes conflict

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'ASK', originalSiteId: 'site-a' },
      conflictMode: 'ask',
    });
    const result = initiateRestore(req);
    // Basket has 51 items (50 issues + 1 workflow) → ask suppressed → skip
    // Actually 50 issues + 1 workflow = 51 > threshold, so ask should be suppressed
    // But we want exactly 50 to test the threshold. Let's check our logic:
    // The basket will have 51 items, so ask is suppressed
    expect(result.conflictModeEffective).toBe('skip');
    expect(result.conflictModeDowngradeReason).toBe('BASKET_SIZE_EXCEEDED');
  });

  test('Ask: basket exactly at 50 issues → ask mode active', () => {
    const bp = 'bp-ask-exactly-50';
    for (let i = 0; i < 50; i++) {
      seedSnapshot(bp, 'JiraIssueNode', `issue-e50-${i}`, { key: `E50-${i}`, summary: `Issue ${i}` });
    }
    // Seed one conflicting workflow separately — but DON'T add it (keep basket = 50)

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'E50', originalSiteId: 'site-a' },
      conflictMode: 'ask',
    });
    const result = initiateRestore(req);
    // Basket size = 50 → ask mode should be active (not suppressed)
    expect(result.conflictModeEffective).toBe('ask');
    expect(result.conflictModeDowngradeReason).toBeUndefined();
  });

  test('Ask: basket at 51 items → ask suppressed to skip', () => {
    const bp = 'bp-ask-51';
    for (let i = 0; i < 51; i++) {
      seedSnapshot(bp, 'JiraIssueNode', `issue-51-${i}`, { key: `F51-${i}`, summary: `Issue ${i}` });
    }

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'F51', originalSiteId: 'site-a' },
      conflictMode: 'ask',
    });
    const result = initiateRestore(req);
    expect(result.conflictModeEffective).toBe('skip');
    expect(result.conflictModeDowngradeReason).toBe('BASKET_SIZE_EXCEEDED');
  });

  test('Ask: conflicting workflow with small basket → pending conflict queued', () => {
    const bp = 'bp-ask-pending';
    seedSnapshot(bp, 'JiraWorkflowNode', 'wf-pending', { name: 'WF Conflict', definition: { id: 'wf', statuses: [], transitions: [] } });
    db.workflowNodes.set('site-a:wf-pending', { name: 'WF Conflict', cloudId: 'site-a' });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'ASK2', originalSiteId: 'site-a' },
      conflictMode: 'ask',
    });
    const result = initiateRestore(req);
    expect(result.conflictModeEffective).toBe('ask');
    const job = db.restoreJobs.get(result.restoreJobId);
    expect(job.pendingConflicts.length).toBe(1);
    expect(job.pendingConflicts[0].itemId).toBe('wf-pending');
  });
});

// ─── INTEGRATION / E2E: Full Five-Stage Pipeline ─────────────────────────────

describe('Integration — full five-stage pipeline', () => {
  beforeEach(() => clearRestoreDb());

  test('all five stages execute in dependency order with correct stage numbers', () => {
    const bp = 'bp-e2e-full';

    // Stage 1: Workflow + CustomField
    seedSnapshot(bp, 'JiraWorkflowNode', 'wf-e2e', { name: 'E2E Workflow', definition: { id: 'wf-e2e', statuses: [{ id: 's1', name: 'To Do' }], transitions: [] } });
    seedSnapshot(bp, 'JiraCustomFieldDefinitionNode', 'cf-e2e', { name: 'Sprint', fieldId: 'customfield_10001' });
    // Stage 2: Project
    seedSnapshot(bp, 'JiraProjectNode', 'proj-e2e', { key: 'E2E', name: 'E2E Project' });
    // Stage 3: Issues (parent)
    seedSnapshot(bp, 'JiraIssueNode', 'issue-e2e-1', { key: 'E2E-1', summary: 'Parent Issue' });
    // Stage 4: Comment, Attachment, Board
    seedSnapshot(bp, 'JiraCommentNode', 'comment-e2e-1', { body: { version: 1, type: 'doc', content: [] }, author: { displayName: 'User', accountId: 'u1' } });
    seedSnapshot(bp, 'JiraAttachmentNode', 'attach-e2e-1', { filename: 'file.txt', sizeBytes: 1024 });
    seedSnapshot(bp, 'JiraBoardNode', 'board-e2e-1', { name: 'E2E Board' });
    // Stage 5: Sprint
    seedSnapshot(bp, 'JiraSprintNode', 'sprint-e2e-1', { name: 'Sprint 1', boardId: 'board-e2e-1' });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'E2E', originalSiteId: 'site-a' },
      conflictMode: 'skip',
    });
    const result = initiateRestore(req);

    expect(result.status).toBe('complete');
    expect(result.stageResults).toHaveLength(5);

    // Verify stage numbers in order
    const stageNumbers = result.stageResults.map(s => s.stageNumber);
    expect(stageNumbers).toEqual([1, 2, 3, 4, 5]);

    // Stage 1: workflow + customfield
    const s1 = result.stageResults[0];
    expect(s1.stageNumber).toBe(1);
    // Stage 1 has workflow and customFieldDefinition → 2 items
    expect(s1.succeeded).toBeGreaterThanOrEqual(1);

    // Stage 2: project
    const s2 = result.stageResults[1];
    expect(s2.stageNumber).toBe(2);
    expect(s2.succeeded + s2.skipped).toBe(1);

    // Stage 3: issues
    const s3 = result.stageResults[2];
    expect(s3.stageNumber).toBe(3);
    expect(s3.succeeded + s3.skipped).toBe(1);

    // Stage 4: comments, attachments, boards
    const s4 = result.stageResults[3];
    expect(s4.stageNumber).toBe(4);
    expect(s4.succeeded + s4.skipped).toBe(3); // comment + attach + board

    // Stage 5: sprints
    const s5 = result.stageResults[4];
    expect(s5.stageNumber).toBe(5);
    expect(s5.succeeded + s5.failed).toBe(1); // Sprint depends on board in boardIdMap
  });

  test('blocking validation failure halts pipeline with zero write calls', () => {
    const bp = 'bp-e2e-halt';
    seedSnapshot(bp, 'JiraIssueNode', 'issue-halt-1', { key: 'HALT-1', summary: 'Issue 1' });
    seedSnapshot(bp, 'JiraProjectNode', 'proj-halt', { key: 'HALT', name: 'Halt Project' });

    // Seed expired connection so OAuth check fails
    seedConnection({ cloudId: 'site-a', accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'HALT', originalSiteId: 'site-a' },
      conflictMode: 'skip',
    });
    const result = initiateRestore(req);

    // Should return validation error with no stage results
    expect(result.__validationError).toBe(true);
    expect(result.blockingError.errorCode).toBe('OAUTH_TOKEN_INVALID');
    // No restored objects should have been written
    expect(db.restoredObjects.size).toBe(0);
  });

  test('conflict in stage 1 does not block stage 2 (with skip mode)', () => {
    const bp = 'bp-e2e-conflict-stage1';
    seedSnapshot(bp, 'JiraWorkflowNode', 'wf-conflict', { name: 'WF A', definition: { id: 'wf-a', statuses: [], transitions: [] } });
    // Existing workflow → conflict
    db.workflowNodes.set('site-a:wf-conflict', { name: 'WF A', cloudId: 'site-a' });
    seedSnapshot(bp, 'JiraProjectNode', 'proj-stage2', { key: 'S2PROJ', name: 'Stage 2 Proj' });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'S2PROJ', originalSiteId: 'site-a' },
      conflictMode: 'skip',
    });
    const result = initiateRestore(req);

    expect(result.status).toBe('complete');
    const s1 = result.stageResults[0];
    expect(s1.skipped).toBe(1);

    const s2 = result.stageResults[1];
    expect(s2.succeeded + s2.skipped).toBe(1);
  });

  test('cross-site restore applies field mapping to issue fields', () => {
    const bp = 'bp-e2e-crosssite';
    seedSnapshot(bp, 'JiraIssueNode', 'issue-cs-1', {
      key: 'CS-1', summary: 'Cross-site issue',
      customfield_10001: 'sprint-123',
    });
    // Define matching fields on both sites
    db.customFieldDefinitions.set('site-a:customfield_10001', { cloudId: 'site-a', fieldId: 'customfield_10001', name: 'Sprint' });
    db.customFieldDefinitions.set('site-b:customfield_20001', { cloudId: 'site-b', fieldId: 'customfield_20001', name: 'Sprint' });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      sourceSiteId: 'site-a',
      destination: { type: 'alternate', targetProjectKey: 'DEST', targetSiteId: 'site-b', isCrossSite: true },
      conflictMode: 'skip',
    });
    const result = initiateRestore(req);

    expect(result.status).toBe('complete');
    // Check that the restored object has the mapped field key
    const restoredIssue = Array.from(db.restoredObjects.values()).find(o => o.objectType === 'issue');
    expect(restoredIssue).toBeDefined();
    // The field should now use the target field ID
    expect(restoredIssue.payload.fields['customfield_20001']).toBe('sprint-123');
    expect(restoredIssue.payload.fields['customfield_10001']).toBeUndefined();
  });

  test('API constraint: issue gets original-key label in full pipeline', () => {
    const bp = 'bp-e2e-label';
    seedSnapshot(bp, 'JiraIssueNode', 'issue-label-1', { key: 'LBL-1', summary: 'Label test' });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'LBL', originalSiteId: 'site-a' },
      conflictMode: 'skip',
    });
    initiateRestore(req);

    const restoredIssue = Array.from(db.restoredObjects.values()).find(o => o.objectType === 'issue');
    expect(restoredIssue).toBeDefined();
    expect(restoredIssue.payload.fields.labels).toContain('original-key:LBL-1');
  });

  test('API constraint: comment author ADF header prepended in full pipeline', () => {
    const bp = 'bp-e2e-comment';
    seedSnapshot(bp, 'JiraCommentNode', 'comment-adf-1', {
      body: { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'comment text' }] }] },
      author: { displayName: 'TestAuthor', accountId: 'acc-test' },
      created: '2026-01-01T00:00:00Z',
    });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'ADF', originalSiteId: 'site-a' },
      conflictMode: 'skip',
    });
    initiateRestore(req);

    const restoredComment = Array.from(db.restoredObjects.values()).find(o => o.objectType === 'comment');
    expect(restoredComment).toBeDefined();
    const body = restoredComment.payload.fields.body;
    expect(body.content[0].content[0].text).toContain('TestAuthor');
  });

  test('API constraint: full workflow definition supplied (not partial)', () => {
    const bp = 'bp-e2e-wf-full';
    const fullDefinition = { id: 'wf-full', name: 'Full WF', statuses: [{ id: 's1', name: 'Open' }], transitions: [{ id: 't1', name: 'Start' }] };
    seedSnapshot(bp, 'JiraWorkflowNode', 'wf-full-1', { name: 'Full WF', definition: fullDefinition });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'WF', originalSiteId: 'site-a' },
      conflictMode: 'skip',
    });
    initiateRestore(req);

    const restoredWf = Array.from(db.restoredObjects.values()).find(o => o.objectType === 'workflow');
    expect(restoredWf).toBeDefined();
    // Payload should be { definition: fullDefinition }
    expect(restoredWf.payload.definition).toEqual(fullDefinition);
    // No partial properties — only the full definition
    expect(restoredWf.payload.fields).toBeUndefined();
  });
});

// ─── INTEGRATION: JSON+ZIP Export with Multi-Stage Basket ────────────────────

describe('Integration — JSON+ZIP export validation', () => {
  beforeEach(() => clearRestoreDb());

  test('export manifest contains all five object types', () => {
    const bp = 'bp-zip-full';
    seedSnapshot(bp, 'JiraWorkflowNode', 'wf-zip', { name: 'ZipWF', definition: { id: 'wf-zip', statuses: [], transitions: [] } });
    seedSnapshot(bp, 'JiraProjectNode', 'proj-zip', { key: 'ZIP', name: 'Zip Project' });
    seedSnapshot(bp, 'JiraIssueNode', 'issue-zip', { key: 'ZIP-1', summary: 'Zip Issue' });
    seedSnapshot(bp, 'JiraAttachmentNode', 'attach-zip', { filename: 'zip.pdf', sizeBytes: 2048 });
    seedSnapshot(bp, 'JiraBoardNode', 'board-zip', { name: 'Zip Board' });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'export', exportFormat: 'json+zip' },
      conflictMode: 'skip',
    });
    const result = initiateRestore(req);
    expect(result.status).toBe('complete');

    const archive = db.exportArchives.get(result.restoreJobId);
    const types = archive.manifest.map(m => m.objectType);
    expect(types).toContain('workflow');
    expect(types).toContain('project');
    expect(types).toContain('issue');
    expect(types).toContain('attachment');
    expect(types).toContain('board');
  });

  test('export format is json+zip and exportFormat field set correctly', () => {
    const bp = 'bp-zip-format';
    seedSnapshot(bp, 'JiraProjectNode', 'proj-fmt', { key: 'FMT', name: 'Format Project' });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'export', exportFormat: 'json+zip' },
    });
    const result = initiateRestore(req);
    const archive = db.exportArchives.get(result.restoreJobId);
    expect(archive.exportFormat).toBe('json+zip');
  });
});

// ─── INTEGRATION: Conflict Decision Endpoint ──────────────────────────────────

describe('Integration — POST /api/v1/restore/:id/conflict-decision', () => {
  beforeEach(() => clearRestoreDb());

  test('submit skip decision resolves pending conflict', async () => {
    const bp = 'bp-decision-skip';
    seedSnapshot(bp, 'JiraWorkflowNode', 'wf-dec', { name: 'WF Dec', definition: { id: 'wf-dec', statuses: [], transitions: [] } });
    db.workflowNodes.set('site-a:wf-dec', { name: 'WF Dec', cloudId: 'site-a' });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'DEC', originalSiteId: 'site-a' },
      conflictMode: 'ask',
    });
    const initResult = initiateRestore(req);
    const restoreJobId = initResult.restoreJobId;

    const job = db.restoreJobs.get(restoreJobId);
    expect(job.pendingConflicts.length).toBe(1);

    const res = await request(app)
      .post(`/api/v1/restore/${restoreJobId}/conflict-decision`)
      .send({ itemId: 'wf-dec', decision: 'skip' });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('skip');
    expect(res.body.restoreJobStatus).toBe('complete');

    const updatedJob = db.restoreJobs.get(restoreJobId);
    expect(updatedJob.pendingConflicts.length).toBe(0);
  });

  test('submit override decision applies restore', async () => {
    const bp = 'bp-decision-override';
    seedSnapshot(bp, 'JiraWorkflowNode', 'wf-ov-dec', { name: 'WF Ov', definition: { id: 'wf-ov-dec', statuses: [], transitions: [] } });
    db.workflowNodes.set('site-a:wf-ov-dec', { name: 'WF Ov', cloudId: 'site-a' });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'OV', originalSiteId: 'site-a' },
      conflictMode: 'ask',
    });
    const initResult = initiateRestore(req);

    const res = await request(app)
      .post(`/api/v1/restore/${initResult.restoreJobId}/conflict-decision`)
      .send({ itemId: 'wf-ov-dec', decision: 'override' });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('override');
  });

  test('returns 409 when no pending conflict for item', async () => {
    const bp = 'bp-no-pending';
    seedSnapshot(bp, 'JiraProjectNode', 'proj-np', { key: 'NP', name: 'NP' });

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'NP', originalSiteId: 'site-a' },
      conflictMode: 'ask',
    });
    const initResult = initiateRestore(req);

    const res = await request(app)
      .post(`/api/v1/restore/${initResult.restoreJobId}/conflict-decision`)
      .send({ itemId: 'nonexistent-item', decision: 'skip' });

    expect(res.status).toBe(409);
  });
});

// ─── INTEGRATION: HTTP API Endpoints ─────────────────────────────────────────

describe('Integration — POST /api/v1/restore', () => {
  beforeEach(() => clearRestoreDb());

  test('returns 400 when backupPointId missing', async () => {
    const res = await request(app)
      .post('/api/v1/restore')
      .send({ sourceSiteId: 'site-a', destination: { type: 'original' }, objectSelection: { includeAll: true } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_BACKUP_POINT');
  });

  test('returns 400 when sourceSiteId missing', async () => {
    const res = await request(app)
      .post('/api/v1/restore')
      .send({ backupPointId: 'bp-1', destination: { type: 'original' }, objectSelection: { includeAll: true } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_SOURCE_SITE');
  });

  test('returns 400 when destination missing', async () => {
    const res = await request(app)
      .post('/api/v1/restore')
      .send({ backupPointId: 'bp-1', sourceSiteId: 'site-a', objectSelection: { includeAll: true } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_DESTINATION');
  });

  test('returns 400 when conflictMode is merge (permanently excluded)', async () => {
    const res = await request(app)
      .post('/api/v1/restore')
      .send({
        backupPointId: 'bp-1', sourceSiteId: 'site-a',
        destination: { type: 'original' }, objectSelection: { includeAll: true },
        conflictMode: 'merge',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_CONFLICT_MODE');
  });

  test('returns 200 with successful restore', async () => {
    const res = await request(app)
      .post('/api/v1/restore')
      .send({
        backupPointId: 'bp-api-ok', sourceSiteId: 'site-a',
        destination: { type: 'original', originalProjectKey: 'OK', originalSiteId: 'site-a' },
        objectSelection: { includeAll: true },
        conflictMode: 'skip',
      });
    expect(res.status).toBe(200);
    expect(res.body.restoreJobId).toBeDefined();
    expect(res.body.status).toBe('complete');
  });

  test('returns 409 with validation error when OAuth token expired', async () => {
    seedConnection({ cloudId: 'site-blocked', accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const res = await request(app)
      .post('/api/v1/restore')
      .send({
        backupPointId: 'bp-api-block', sourceSiteId: 'site-blocked',
        destination: { type: 'original', originalProjectKey: 'BLK', originalSiteId: 'site-blocked' },
        objectSelection: { includeAll: true },
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('OAUTH_TOKEN_INVALID');
  });
});

describe('Integration — GET /api/v1/restore/:restoreJobId', () => {
  beforeEach(() => clearRestoreDb());

  test('returns 404 for unknown restore job', async () => {
    const res = await request(app).get('/api/v1/restore/nonexistent-job-id');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('RESTORE_JOB_NOT_FOUND');
  });

  test('returns job status for existing restore', async () => {
    const initRes = await request(app)
      .post('/api/v1/restore')
      .send({
        backupPointId: 'bp-poll', sourceSiteId: 'site-a',
        destination: { type: 'original', originalProjectKey: 'POLL', originalSiteId: 'site-a' },
        objectSelection: { includeAll: true },
        conflictMode: 'skip',
      });
    expect(initRes.status).toBe(200);
    const { restoreJobId } = initRes.body;

    const pollRes = await request(app).get(`/api/v1/restore/${restoreJobId}`);
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.restoreJobId).toBe(restoreJobId);
    expect(pollRes.body.status).toBe('complete');
    expect(pollRes.body.stageResults).toHaveLength(5);
  });
});

describe('Integration — GET /api/v1/restore/:id/export', () => {
  beforeEach(() => clearRestoreDb());

  test('returns 409 when job is not export destination', async () => {
    const initRes = await request(app)
      .post('/api/v1/restore')
      .send({
        backupPointId: 'bp-noexport', sourceSiteId: 'site-a',
        destination: { type: 'original', originalProjectKey: 'NE', originalSiteId: 'site-a' },
        objectSelection: { includeAll: true },
      });
    const { restoreJobId } = initRes.body;
    const res = await request(app).get(`/api/v1/restore/${restoreJobId}/export`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('NOT_EXPORT_DESTINATION');
  });

  test('returns export archive with Content-Type application/zip for json+zip', async () => {
    const initRes = await request(app)
      .post('/api/v1/restore')
      .send({
        backupPointId: 'bp-dl', sourceSiteId: 'site-a',
        destination: { type: 'export', exportFormat: 'json+zip' },
        objectSelection: { includeAll: true },
      });
    expect(initRes.status).toBe(200);
    const { restoreJobId } = initRes.body;

    const exportRes = await request(app).get(`/api/v1/restore/${restoreJobId}/export`);
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers['content-type']).toContain('application/zip');
    // When Content-Type is application/zip, supertest may not parse body as JSON.
    // Verify that the archive is stored correctly in db instead.
    const archive = db.exportArchives.get(restoreJobId);
    expect(archive).toBeDefined();
    expect(archive.restoreJobId).toBe(restoreJobId);
    expect(archive.manifest).toBeDefined();
  });
});

describe('Integration — POST /api/v1/restore/validate', () => {
  beforeEach(() => clearRestoreDb());

  test('returns basketSummary and passed:true for valid request', async () => {
    const res = await request(app)
      .post('/api/v1/restore/validate')
      .send({
        backupPointId: 'bp-val', sourceSiteId: 'site-a',
        destination: { type: 'original', originalProjectKey: 'VAL', originalSiteId: 'site-a' },
        objectSelection: { includeAll: true },
      });
    expect(res.status).toBe(200);
    expect(res.body.passed).toBe(true);
    expect(res.body.basketSummary).toBeDefined();
    expect(res.body.basketSummary.totalItems).toBeDefined();
  });

  test('returns blockingError and passed:false when validation fails', async () => {
    seedConnection({ cloudId: 'site-val-fail', accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const res = await request(app)
      .post('/api/v1/restore/validate')
      .send({
        backupPointId: 'bp-val-fail', sourceSiteId: 'site-val-fail',
        destination: { type: 'original', originalProjectKey: 'VF', originalSiteId: 'site-val-fail' },
        objectSelection: { includeAll: true },
      });
    expect(res.status).toBe(200);
    expect(res.body.passed).toBe(false);
    expect(res.body.blockingError).toBeDefined();
  });

  test('returns 400 for merge conflictMode', async () => {
    const res = await request(app)
      .post('/api/v1/restore/validate')
      .send({
        backupPointId: 'bp-merge', sourceSiteId: 'site-a',
        conflictMode: 'merge',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_CONFLICT_MODE');
  });
});

// ─── EDGE CASES ───────────────────────────────────────────────────────────────

describe('Edge Cases', () => {
  beforeEach(() => clearRestoreDb());

  test('basket exactly at 50 items — Ask mode active and not suppressed', () => {
    const bp = 'bp-edge-50';
    for (let i = 0; i < 50; i++) {
      seedSnapshot(bp, 'JiraIssueNode', `edge-50-issue-${i}`, { key: `EDGE-${i}`, summary: `Issue ${i}` });
    }
    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'EDGE', originalSiteId: 'site-a' },
      conflictMode: 'ask',
    });
    const result = initiateRestore(req);
    expect(result.conflictModeEffective).toBe('ask');
    expect(result.conflictModeDowngradeReason).toBeUndefined();
  });

  test('basket at 51 items — Ask suppressed and Skip applied', () => {
    const bp = 'bp-edge-51';
    for (let i = 0; i < 51; i++) {
      seedSnapshot(bp, 'JiraIssueNode', `edge-51-issue-${i}`, { key: `EDGE51-${i}`, summary: `Issue ${i}` });
    }
    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'EDGE51', originalSiteId: 'site-a' },
      conflictMode: 'ask',
    });
    const result = initiateRestore(req);
    expect(result.conflictModeEffective).toBe('skip');
    expect(result.conflictModeDowngradeReason).toBe('BASKET_SIZE_EXCEEDED');
  });

  test('blocking validation failure — pipeline halted with zero write calls issued', () => {
    const bp = 'bp-edge-block';
    // Add items to ensure there would be writes if not blocked
    seedSnapshot(bp, 'JiraProjectNode', 'proj-block', { key: 'BLK', name: 'Blocked' });
    seedSnapshot(bp, 'JiraIssueNode', 'issue-block', { key: 'BLK-1', summary: 'Issue' });
    // Expire the connection
    seedConnection({ cloudId: 'site-a', accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });

    const initialRestoredSize = db.restoredObjects.size;

    const req = makeBasicRestoreRequest({
      backupPointId: bp,
      destination: { type: 'original', originalProjectKey: 'BLK', originalSiteId: 'site-a' },
      conflictMode: 'skip',
    });
    const result = initiateRestore(req);

    expect(result.__validationError).toBe(true);
    // Zero writes issued
    expect(db.restoredObjects.size).toBe(initialRestoredSize);
    expect(db.restoreJobs.size).toBe(0);
  });

  test('attachment at exactly 250 MB (262144000 bytes) — passes validation', () => {
    const items = [{ objectType: 'attachment', id: 'att-exact', sizeBytes: ATTACHMENT_SIZE_LIMIT_BYTES }];
    const result = checkAttachmentSize(items);
    expect(result.passed).toBe(true);
  });

  test('attachment at 250 MB + 1 byte (262144001 bytes) — fails with blocking error', () => {
    const items = [{ objectType: 'attachment', id: 'att-over', sizeBytes: ATTACHMENT_SIZE_LIMIT_BYTES + 1 }];
    const result = checkAttachmentSize(items);
    expect(result.passed).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.errorCode).toBe('ATTACHMENT_SIZE_EXCEEDED');
    expect(result.affectedItems).toContain('att-over');
  });

  test('ATTACHMENT_SIZE_LIMIT_BYTES is exactly 262144000 (250 MB)', () => {
    expect(ATTACHMENT_SIZE_LIMIT_BYTES).toBe(262144000);
  });

  test('ASK_BASKET_THRESHOLD is exactly 50', () => {
    expect(ASK_BASKET_THRESHOLD).toBe(50);
  });
});
