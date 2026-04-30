'use strict';

/**
 * Sprint 4 — Restore Engine Constants
 *
 * JavaScript mirror of packages/shared-types/src/restoreConstants.ts.
 * All values derived from restore-engine-architecture.md.
 */

// ── Stage Order ───────────────────────────────────────────────────────────────

const RESTORE_STAGE_ORDER = Object.freeze({
  WORKFLOWS_AND_CUSTOM_FIELDS: 1,
  PROJECTS: 2,
  PARENT_ISSUES: 3,
  COMMENTS_ATTACHMENTS_BOARDS: 4,
  SPRINTS: 5,
});

// ── Conflict Mode ─────────────────────────────────────────────────────────────

const CONFLICT_MODE = Object.freeze({
  SKIP: 'skip',
  OVERRIDE: 'override',
  ASK: 'ask',
});

/** ask mode is silently downgraded to skip when basket size exceeds this value. */
const ASK_BASKET_THRESHOLD = 50;

// ── Restore Destination ───────────────────────────────────────────────────────

const RESTORE_DESTINATION = Object.freeze({
  ORIGINAL_LOCATION: 'original',
  ALTERNATE_LOCATION: 'alternate',
  JSON_ZIP_EXPORT: 'export',
});

// ── Validation Check Types ────────────────────────────────────────────────────

const VALIDATION_CHECK_TYPE = Object.freeze({
  OAUTH_TOKEN_VALIDITY: 1,
  TARGET_PROJECT_EXISTENCE: 2,
  TARGET_PROJECT_ARCHIVE_STATUS: 3,
  JIRA_SOFTWARE_ACTIVE: 4,
  WORKFLOW_STATUS_NAMES: 5,
  CUSTOM_FIELD_PRESENCE: 6,
  ATTACHMENT_SIZE: 7,
});

/**
 * Whether each validation check is blocking.
 * Check 4 is blocking only for Board/Sprint restores (caller applies conditionally).
 * Check 6 is blocking for required fields only (per-field determination at runtime).
 */
const VALIDATION_CHECK_BLOCKING = Object.freeze({
  [VALIDATION_CHECK_TYPE.OAUTH_TOKEN_VALIDITY]: true,
  [VALIDATION_CHECK_TYPE.TARGET_PROJECT_EXISTENCE]: true,
  [VALIDATION_CHECK_TYPE.TARGET_PROJECT_ARCHIVE_STATUS]: true,
  [VALIDATION_CHECK_TYPE.JIRA_SOFTWARE_ACTIVE]: true,
  [VALIDATION_CHECK_TYPE.WORKFLOW_STATUS_NAMES]: false,
  [VALIDATION_CHECK_TYPE.CUSTOM_FIELD_PRESENCE]: true,
  [VALIDATION_CHECK_TYPE.ATTACHMENT_SIZE]: true,
});

// ── Attachment Size Limit ─────────────────────────────────────────────────────

/** Maximum attachment size in bytes (250 MB). */
const ATTACHMENT_SIZE_LIMIT_BYTES = 262144000;

// ── Issue Key Label ───────────────────────────────────────────────────────────

/** Prefix used when stamping the original issue key as a label, e.g. original-key:PROJ-123 */
const ISSUE_KEY_LABEL_PREFIX = 'original-key:';

// ── Attribution Templates ─────────────────────────────────────────────────────

/**
 * Plain-text header line prepended to restored comment bodies to preserve
 * the original reporter identity.
 *
 * Usage: replace {displayName} and {emailAddress} with actual values.
 */
const REPORTER_ATTRIBUTION_HEADER =
  '[Restored from backup — original reporter: {displayName} <{emailAddress}>]';

/**
 * ADF paragraph node structure prepended as the first node in a restored
 * comment body to preserve the original comment author identity.
 *
 * The `text` field uses template placeholders:
 *   {authorDisplayName}   — original author's display name
 *   {originalCreatedDate} — ISO 8601 creation timestamp
 */
const COMMENT_AUTHOR_ADF_NODE = Object.freeze({
  type: 'paragraph',
  content: [
    {
      type: 'text',
      text: '[Original comment by: {authorDisplayName} on {originalCreatedDate}]',
    },
  ],
});

module.exports = {
  RESTORE_STAGE_ORDER,
  CONFLICT_MODE,
  ASK_BASKET_THRESHOLD,
  RESTORE_DESTINATION,
  VALIDATION_CHECK_TYPE,
  VALIDATION_CHECK_BLOCKING,
  ATTACHMENT_SIZE_LIMIT_BYTES,
  ISSUE_KEY_LABEL_PREFIX,
  REPORTER_ATTRIBUTION_HEADER,
  COMMENT_AUTHOR_ADF_NODE,
};
