// ─── Restore Engine — Constants & Configuration Schemas ──────────────────────
// All values derived from restore-engine-architecture.md.

// ── Stage Order ───────────────────────────────────────────────────────────────

export enum RESTORE_STAGE_ORDER {
  WORKFLOWS_AND_CUSTOM_FIELDS = 1,
  PROJECTS = 2,
  PARENT_ISSUES = 3,
  COMMENTS_ATTACHMENTS_BOARDS = 4,
  SPRINTS = 5,
}

// ── Conflict Mode ─────────────────────────────────────────────────────────────

export enum CONFLICT_MODE {
  SKIP = 'skip',
  OVERRIDE = 'override',
  ASK = 'ask',
}

/** ask mode is silently downgraded to skip when basket size exceeds this value. */
export const ASK_BASKET_THRESHOLD = 50;

// ── Restore Destination ───────────────────────────────────────────────────────

export enum RESTORE_DESTINATION {
  ORIGINAL_LOCATION = 'original',
  ALTERNATE_LOCATION = 'alternate',
  JSON_ZIP_EXPORT = 'export',
}

// ── Validation Check Types ────────────────────────────────────────────────────

export enum VALIDATION_CHECK_TYPE {
  OAUTH_TOKEN_VALIDITY = 1,
  TARGET_PROJECT_EXISTENCE = 2,
  TARGET_PROJECT_ARCHIVE_STATUS = 3,
  JIRA_SOFTWARE_ACTIVE = 4,
  WORKFLOW_STATUS_NAMES = 5,
  CUSTOM_FIELD_PRESENCE = 6,
  ATTACHMENT_SIZE = 7,
}

/**
 * Whether each validation check is blocking.
 *
 * Check 4 (JIRA_SOFTWARE_ACTIVE) is blocking only for Board/Sprint restores;
 * the caller must conditionally apply it. Check 6 (CUSTOM_FIELD_PRESENCE) is
 * blocking for required fields and non-blocking for optional fields; the
 * per-field determination is made at runtime. The value here reflects the
 * blocking classification for the primary / required-field case.
 */
export const VALIDATION_CHECK_BLOCKING: Readonly<Record<VALIDATION_CHECK_TYPE, boolean>> = {
  [VALIDATION_CHECK_TYPE.OAUTH_TOKEN_VALIDITY]: true,
  [VALIDATION_CHECK_TYPE.TARGET_PROJECT_EXISTENCE]: true,
  [VALIDATION_CHECK_TYPE.TARGET_PROJECT_ARCHIVE_STATUS]: true,
  [VALIDATION_CHECK_TYPE.JIRA_SOFTWARE_ACTIVE]: true,         // blocking for Board/Sprint
  [VALIDATION_CHECK_TYPE.WORKFLOW_STATUS_NAMES]: false,       // non-blocking (warn)
  [VALIDATION_CHECK_TYPE.CUSTOM_FIELD_PRESENCE]: true,        // blocking for required fields
  [VALIDATION_CHECK_TYPE.ATTACHMENT_SIZE]: true,
};

// ── Attachment Size Limit ─────────────────────────────────────────────────────

/** Maximum attachment size in bytes (250 MB). */
export const ATTACHMENT_SIZE_LIMIT_BYTES = 262_144_000;

// ── Issue Key Label ───────────────────────────────────────────────────────────

/** Prefix used when stamping the original issue key as a label, e.g. original-key:PROJ-123 */
export const ISSUE_KEY_LABEL_PREFIX = 'original-key:';

// ── Attribution Templates ─────────────────────────────────────────────────────

/**
 * Plain-text header line prepended to restored comment bodies to preserve
 * the original reporter identity.
 *
 * Usage: replace {displayName} and {emailAddress} with actual values.
 *
 * Example: "[Restored from backup — original reporter: Jane Doe <jane@example.com>]"
 */
export const REPORTER_ATTRIBUTION_HEADER =
  '[Restored from backup — original reporter: {displayName} <{emailAddress}>]';

/**
 * ADF paragraph node structure prepended as the first node in a restored
 * comment body to preserve the original comment author identity.
 *
 * The `text` field uses template placeholders:
 *   {authorDisplayName}   — original author's display name
 *   {originalCreatedDate} — ISO 8601 creation timestamp
 *
 * Example rendered text:
 *   "[Original comment by: Jane Doe on 2025-03-15T10:00:00.000Z]"
 */
export const COMMENT_AUTHOR_ADF_NODE = {
  type: 'paragraph',
  content: [
    {
      type: 'text',
      text: '[Original comment by: {authorDisplayName} on {originalCreatedDate}]',
    },
  ],
} as const;
