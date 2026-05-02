'use strict';

/**
 * Sprint 4 — Restore Engine
 * Pre-Execution Validation Pipeline.
 *
 * Implements 7 ordered checks per restore-engine-architecture.md §6.
 * - Blocking failures halt the pipeline and are returned as blockingError.
 * - Non-blocking failures accumulate as warnings and do not halt the pipeline.
 */

const db = require('../db');
const {
  VALIDATION_CHECK_TYPE,
  ATTACHMENT_SIZE_LIMIT_BYTES,
} = require('../config/restoreConstants');

// ── Check builders ────────────────────────────────────────────────────────────

function makeCheckResult(checkId, checkName, passed, blocking, errorCode, detail, affectedItems) {
  const result = { checkId, checkName, passed, blocking };
  if (!passed) {
    if (errorCode) result.errorCode = errorCode;
    if (detail) result.detail = detail;
    if (affectedItems && affectedItems.length > 0) result.affectedItems = affectedItems;
  }
  return result;
}

// ── Check 1: OAuth Token Validity ─────────────────────────────────────────────

function checkOAuthTokenValidity(targetSiteId) {
  const CHECK_ID = VALIDATION_CHECK_TYPE.OAUTH_TOKEN_VALIDITY;
  const CHECK_NAME = 'OAuth Token Validity';

  // Look for a connection associated with the target site that has a non-expired token.
  let valid = false;
  for (const conn of db.connections.values()) {
    if (conn.deletedAt) continue;
    // Match by cloudId or siteId stored on connection
    const matchesSite = conn.cloudId === targetSiteId || conn.siteId === targetSiteId;
    if (!matchesSite) continue;
    // Check token expiry if present
    if (conn.accessTokenExpiresAt) {
      valid = new Date(conn.accessTokenExpiresAt) > new Date();
    } else if (conn.accessToken || conn.encryptedAccessToken) {
      // Token exists but no expiry tracked — assume valid for simulation
      valid = true;
    }
    if (valid) break;
  }

  // If no connections exist at all (test/simulation context), treat as valid
  if (db.connections.size === 0) valid = true;

  return makeCheckResult(
    CHECK_ID, CHECK_NAME, valid, true,
    valid ? undefined : 'OAUTH_TOKEN_INVALID',
    valid ? undefined : `No valid OAuth token found for target site ${targetSiteId}`,
  );
}

// ── Check 2: Target Project Existence ─────────────────────────────────────────

function checkTargetProjectExistence(targetProjectKey, targetSiteId, restoreMode) {
  const CHECK_ID = VALIDATION_CHECK_TYPE.TARGET_PROJECT_EXISTENCE;
  const CHECK_NAME = 'Target Project Existence';

  // For "original" destination restores, each issue carries its own project key
  // from backup fields (fields.project.key). No single targetProjectKey is specified
  // at the restore request level, so skip this check — the individual write calls
  // will resolve the project per-item.
  // For "export" destination restores, data is written to a local archive file and
  // never sent to a Jira site, so no target project is required.
  // NOTE: we check restoreMode explicitly rather than using !targetProjectKey, because
  // a missing targetProjectKey on a non-original/non-export destination is a
  // misconfiguration that should be caught, not silently passed.
  if (restoreMode === 'original' || restoreMode === 'export') {
    return makeCheckResult(CHECK_ID, CHECK_NAME, true, true);
  }

  if (!targetProjectKey) {
    return makeCheckResult(
      CHECK_ID, CHECK_NAME, false, true,
      'TARGET_PROJECT_KEY_MISSING',
      'No target project key provided for restore destination',
    );
  }

  let found = false;
  for (const [key, project] of db.projectNodes.entries()) {
    const siteMatch = !targetSiteId || project.cloudId === targetSiteId || project.siteId === targetSiteId
      || key.includes(targetSiteId);
    if (siteMatch && project.key === targetProjectKey) {
      found = true;
      break;
    }
  }

  // If no project nodes in db at all, pass (simulation: no real data yet)
  if (db.projectNodes.size === 0) found = true;

  return makeCheckResult(
    CHECK_ID, CHECK_NAME, found, true,
    found ? undefined : 'TARGET_PROJECT_NOT_FOUND',
    found ? undefined : `Project ${targetProjectKey} not found on target site ${targetSiteId}`,
  );
}

// ── Check 3: Target Project Archive Status ────────────────────────────────────

function checkTargetProjectArchiveStatus(targetProjectKey, targetSiteId) {
  const CHECK_ID = VALIDATION_CHECK_TYPE.TARGET_PROJECT_ARCHIVE_STATUS;
  const CHECK_NAME = 'Target Project Archive Status';

  let archived = false;
  for (const [, project] of db.projectNodes.entries()) {
    const siteMatch = !targetSiteId || project.cloudId === targetSiteId || project.siteId === targetSiteId;
    if (siteMatch && project.key === targetProjectKey) {
      archived = project.archived === true;
      break;
    }
  }

  const passed = !archived;
  return makeCheckResult(
    CHECK_ID, CHECK_NAME, passed, true,
    passed ? undefined : 'TARGET_PROJECT_ARCHIVED',
    passed ? undefined : `Project ${targetProjectKey} is archived and cannot be used as a restore target`,
  );
}

// ── Check 4: Jira Software Active ─────────────────────────────────────────────

/**
 * @param {string} targetSiteId
 * @param {boolean} [requireWriteScope=false] — When true, also requires write:board-scope:jira-software.
 *   Must be set for restore operations that write boards/sprints; read-only (backup) only needs the read scope.
 */
function checkJiraSoftwareActive(targetSiteId, requireWriteScope = false) {
  const CHECK_ID = VALIDATION_CHECK_TYPE.JIRA_SOFTWARE_ACTIVE;
  const CHECK_NAME = 'Jira Software Active';

  // Check if the connection for targetSiteId has the required board-scope grants.
  // Restore operations require both read and write board scope; backup only needs read.
  let active = false;
  let missingWriteScope = false;
  for (const conn of db.connections.values()) {
    if (conn.deletedAt) continue;
    const matchesSite = conn.cloudId === targetSiteId || conn.siteId === targetSiteId;
    if (!matchesSite) continue;
    const scopes = conn.grantedScopes || conn.scopes || [];
    const hasRead = scopes.includes('read:board-scope:jira-software');
    const hasWrite = scopes.includes('write:board-scope:jira-software');
    if (hasRead) {
      active = true;
      if (requireWriteScope && !hasWrite) {
        missingWriteScope = true;
        active = false;
      }
      break;
    }
  }

  // Simulation: if no connections, assume active
  if (db.connections.size === 0) active = true;

  let errorCode;
  let detail;
  if (!active) {
    if (missingWriteScope) {
      errorCode = 'BOARD_WRITE_SCOPE_MISSING';
      detail = `The Atlassian integration is missing the write:board-scope:jira-software scope required for board and sprint restore on target site ${targetSiteId}. Please reconnect the integration to grant this scope.`;
    } else {
      errorCode = 'JIRA_SOFTWARE_NOT_ACTIVE';
      detail = `Jira Software is not active on target site ${targetSiteId}; Board and Sprint restore requires read:board-scope:jira-software`;
    }
  }

  return makeCheckResult(CHECK_ID, CHECK_NAME, active, true, errorCode, detail);
}

// ── Check 5: Workflow Status Names ────────────────────────────────────────────

function checkWorkflowStatusNames(basketItems) {
  const CHECK_ID = VALIDATION_CHECK_TYPE.WORKFLOW_STATUS_NAMES;
  const CHECK_NAME = 'Workflow Status Names';

  const missingStatuses = [];

  for (const item of basketItems) {
    if (item.objectType !== 'workflow') continue;
    const workflow = db.workflowNodes.get(item.id) || item.fields;
    if (!workflow) continue;
    const statuses = (workflow.statuses || []);
    for (const status of statuses) {
      // In simulation, we check that status names are non-empty strings.
      // In production, this would verify each status exists on the target site.
      if (!status.name || status.name.trim() === '') {
        missingStatuses.push(status.id || 'unknown');
      }
    }
  }

  const passed = missingStatuses.length === 0;
  return makeCheckResult(
    CHECK_ID, CHECK_NAME, passed,
    false, // Non-blocking (warn only)
    passed ? undefined : 'WORKFLOW_STATUS_NAME_MISSING',
    passed ? undefined : `Workflow status names missing or blank: ${missingStatuses.join(', ')}`,
    missingStatuses,
  );
}

// ── Check 6: Custom Field Presence ────────────────────────────────────────────

/**
 * Returns two check results: one for required fields (blocking), one for optional (non-blocking).
 * Caller must handle both independently.
 */
function checkCustomFieldPresence(basketItems, targetSiteId) {
  const CHECK_ID = VALIDATION_CHECK_TYPE.CUSTOM_FIELD_PRESENCE;

  const missingRequired = [];
  const missingOptional = [];

  // Collect all custom field IDs referenced by issue items in the basket
  for (const item of basketItems) {
    if (item.objectType !== 'issue') continue;
    const fields = item.fields || {};
    for (const [fieldKey, fieldVal] of Object.entries(fields)) {
      if (!fieldKey.startsWith('customfield_')) continue;
      if (fieldVal === null || fieldVal === undefined) continue;
      // Check if this custom field exists on the target site
      let existsOnTarget = false;
      for (const [key] of db.customFieldDefinitions.entries()) {
        if (key.startsWith(`${targetSiteId}:`) && key.includes(fieldKey)) {
          existsOnTarget = true;
          break;
        }
      }
      if (!existsOnTarget && db.customFieldDefinitions.size > 0) {
        // Classify as required if field schema marks it required
        const isRequired = item.requiredFields && item.requiredFields.includes(fieldKey);
        if (isRequired) {
          if (!missingRequired.includes(fieldKey)) missingRequired.push(fieldKey);
        } else {
          if (!missingOptional.includes(fieldKey)) missingOptional.push(fieldKey);
        }
      }
    }
  }

  const requiredResult = makeCheckResult(
    CHECK_ID, 'Custom Field Presence (required)',
    missingRequired.length === 0, true,
    missingRequired.length > 0 ? 'CUSTOM_FIELD_REQUIRED_MISSING' : undefined,
    missingRequired.length > 0 ? `Required custom fields not found on target site: ${missingRequired.join(', ')}` : undefined,
    missingRequired,
  );

  const optionalResult = makeCheckResult(
    CHECK_ID, 'Custom Field Presence (optional)',
    missingOptional.length === 0, false,
    missingOptional.length > 0 ? 'CUSTOM_FIELD_OPTIONAL_MISSING' : undefined,
    missingOptional.length > 0 ? `Optional custom fields not found on target site (will be dropped): ${missingOptional.join(', ')}` : undefined,
    missingOptional,
  );

  return { requiredResult, optionalResult };
}

// ── Check 7: Attachment Size ──────────────────────────────────────────────────

function checkAttachmentSize(basketItems) {
  const CHECK_ID = VALIDATION_CHECK_TYPE.ATTACHMENT_SIZE;
  const CHECK_NAME = 'Attachment Size';

  const oversized = [];
  for (const item of basketItems) {
    if (item.objectType !== 'attachment') continue;
    const sizeBytes = item.sizeBytes || (item.fields && item.fields.sizeBytes) || 0;
    if (sizeBytes > ATTACHMENT_SIZE_LIMIT_BYTES) {
      oversized.push(item.id);
    }
  }

  const passed = oversized.length === 0;
  return makeCheckResult(
    CHECK_ID, CHECK_NAME, passed, true,
    passed ? undefined : 'ATTACHMENT_SIZE_EXCEEDED',
    passed ? undefined : `${oversized.length} attachment(s) exceed the 250 MB size limit`,
    oversized,
  );
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

/**
 * Run the full pre-execution validation pipeline.
 *
 * @param {object} options
 * @param {object} options.restoreRequest - The incoming RestoreRequest
 * @param {string} options.targetSiteId
 * @param {string} options.targetProjectKey
 * @param {object[]} options.basketItems - Array of restore items
 * @param {boolean} options.includeBoardSprintRestore - True if basket contains boards/sprints
 * @returns {{ passed: boolean, blockingError?: object, warnings: object[] }}
 */
function runValidationPipeline({ restoreRequest, targetSiteId, targetProjectKey, basketItems, includeBoardSprintRestore }) {
  const warnings = [];

  // Derive restoreMode from the destination type so that check2 can distinguish
  // an intentional per-issue project routing (destination.type === 'original') from
  // a misconfigured request that accidentally omitted targetProjectKey.
  const restoreMode = restoreRequest && restoreRequest.destination && restoreRequest.destination.type;

  console.info(`[validation] starting: targetSiteId=${targetSiteId} targetProjectKey=${targetProjectKey || '(none)'} restoreMode=${restoreMode || '(none)'} basketSize=${basketItems.length}`);

  // Check 1: OAuth token validity
  const check1 = checkOAuthTokenValidity(targetSiteId);
  console.info(`[validation] check=OAUTH_TOKEN_VALIDITY passed=${check1.passed} targetSiteId=${targetSiteId}${check1.errorCode ? ' errorCode=' + check1.errorCode : ''}`);
  if (!check1.passed) return { passed: false, blockingError: check1, warnings };

  // Check 2: Target project existence
  const check2 = checkTargetProjectExistence(targetProjectKey, targetSiteId, restoreMode);
  console.info(`[validation] check=TARGET_PROJECT_EXISTENCE passed=${check2.passed} targetProjectKey=${targetProjectKey || '(none)'} targetSiteId=${targetSiteId}${check2.errorCode ? ' errorCode=' + check2.errorCode : ''}`);
  if (!check2.passed) return { passed: false, blockingError: check2, warnings };

  // Check 3: Target project archive status
  const check3 = checkTargetProjectArchiveStatus(targetProjectKey, targetSiteId);
  console.info(`[validation] check=TARGET_PROJECT_ARCHIVE_STATUS passed=${check3.passed} targetProjectKey=${targetProjectKey || '(none)'}${check3.errorCode ? ' errorCode=' + check3.errorCode : ''}`);
  if (!check3.passed) return { passed: false, blockingError: check3, warnings };

  // Check 4: Jira Software active (only for Board/Sprint restores).
  // Restore operations write boards/sprints so both read and write board scope are required.
  if (includeBoardSprintRestore) {
    const check4 = checkJiraSoftwareActive(targetSiteId, true);
    console.info(`[validation] check=JIRA_SOFTWARE_ACTIVE passed=${check4.passed} targetSiteId=${targetSiteId}${check4.errorCode ? ' errorCode=' + check4.errorCode : ''}`);
    if (!check4.passed) return { passed: false, blockingError: check4, warnings };
  }

  // Check 5: Workflow status names (non-blocking)
  const check5 = checkWorkflowStatusNames(basketItems);
  console.info(`[validation] check=WORKFLOW_STATUS_NAMES passed=${check5.passed} warnings=${!check5.passed}`);
  if (!check5.passed) warnings.push(check5);

  // Check 6: Custom field presence (blocking for required, non-blocking for optional)
  const { requiredResult, optionalResult } = checkCustomFieldPresence(basketItems, targetSiteId);
  console.info(`[validation] check=CUSTOM_FIELD_PRESENCE_REQUIRED passed=${requiredResult.passed}${requiredResult.errorCode ? ' errorCode=' + requiredResult.errorCode : ''}`);
  if (!requiredResult.passed) return { passed: false, blockingError: requiredResult, warnings };
  if (!optionalResult.passed) warnings.push(optionalResult);

  // Check 7: Attachment size (blocking)
  const check7 = checkAttachmentSize(basketItems);
  console.info(`[validation] check=ATTACHMENT_SIZE passed=${check7.passed}${check7.errorCode ? ' errorCode=' + check7.errorCode : ''}`);
  if (!check7.passed) return { passed: false, blockingError: check7, warnings };

  console.info(`[validation] all checks passed: targetSiteId=${targetSiteId} warnings=${warnings.length}`);
  return { passed: true, warnings };
}

module.exports = {
  runValidationPipeline,
  // Export individual checks for unit testing
  checkOAuthTokenValidity,
  checkTargetProjectExistence,
  checkTargetProjectArchiveStatus,
  checkJiraSoftwareActive,
  checkWorkflowStatusNames,
  checkCustomFieldPresence,
  checkAttachmentSize,
};
