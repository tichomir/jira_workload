'use strict';

// ---------------------------------------------------------------------------
// SLA Domain defaults
// ---------------------------------------------------------------------------

/** Recovery Point Objective default: 24 hours in seconds */
const RPO_DEFAULT = 86400;

/** Retention default: 365 days */
const RETENTION_DEFAULT = 365;

// ---------------------------------------------------------------------------
// Data Scope refresh
// ---------------------------------------------------------------------------

/** Data Scope refresh interval default: 24 hours in seconds */
const DATA_SCOPE_REFRESH_INTERVAL_DEFAULT = 86400;

// ---------------------------------------------------------------------------
// Configuration A policy model
// ---------------------------------------------------------------------------

/**
 * Configuration A policy model constants.
 * Defines the standard backup policy tier used for Jira integrations.
 */
const POLICY_MODEL_CONFIG_A = {
  name: 'Configuration A',
  slaDomain: 'standard',
  rpo: RPO_DEFAULT,
  retentionDays: RETENTION_DEFAULT,
  archiveScopeEnabled: true,
  secondaryCopyEnabled: true,
};

// ---------------------------------------------------------------------------
// Copy capability flags
// ---------------------------------------------------------------------------

/** Secondary Copy capability flag */
const SECONDARY_COPY_ENABLED = true;

/** Archive Copy capability flag */
const ARCHIVE_COPY_ENABLED = true;

// ---------------------------------------------------------------------------
// Archive scope attributes
// ---------------------------------------------------------------------------

/**
 * Maps each node type to the attribute key/value pair that marks it as archived.
 * Used when filtering objects into the archive scope of a backup.
 *
 * @type {Record<string, { key: string, value: boolean | string }>}
 */
const ARCHIVE_SCOPE_ATTRIBUTES = {
  JiraProjectNode: { key: 'archived', value: true },
  JiraIssueNode: { key: 'statusCategory', value: 'Done' },
  JiraSprintNode: { key: 'state', value: 'closed' },
};

// ---------------------------------------------------------------------------
// Purge cascade exclusions
// ---------------------------------------------------------------------------

/**
 * Node types excluded from the purge cascade at the platform layer.
 * These objects are never deleted as a side-effect of purging parent objects.
 *
 * @type {string[]}
 */
const PURGE_CASCADE_EXCLUSIONS = [
  'JiraWorkflowNode',
  'JiraCustomFieldDefinitionNode',
  'JiraCustomFieldContextNode',
];

// ---------------------------------------------------------------------------
// JSDoc type definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AttachmentManifestRecord
 * @property {string}  attachmentId      - Jira attachment ID.
 * @property {string}  backupPointId     - ID of the backup point that owns this record.
 * @property {string}  binaryStorageRef  - Reference (path/URI) to the stored binary in object storage.
 * @property {boolean} sidecarOnly       - True when the binary was not re-downloaded; carried forward from a prior backup point.
 * @property {string}  checksum          - SHA-256 hex digest of the binary content.
 */

/**
 * @typedef {Object} SlaDomain
 * @property {string} name         - Human-readable SLA domain name (e.g. "standard").
 * @property {number} rpo          - Recovery Point Objective in seconds.
 * @property {number} retentionDays - Number of days backup data is retained.
 */

/**
 * @typedef {Object} PolicyConfig
 * @property {string}  slaDomain            - SLA domain identifier.
 * @property {number}  rpo                  - Recovery Point Objective in seconds.
 * @property {number}  retentionDays        - Retention period in days.
 * @property {boolean} archiveScopeEnabled  - Whether archive scope filtering is active.
 * @property {boolean} secondaryCopyEnabled - Whether secondary copy creation is active.
 */

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  RPO_DEFAULT,
  RETENTION_DEFAULT,
  DATA_SCOPE_REFRESH_INTERVAL_DEFAULT,
  POLICY_MODEL_CONFIG_A,
  SECONDARY_COPY_ENABLED,
  ARCHIVE_COPY_ENABLED,
  ARCHIVE_SCOPE_ATTRIBUTES,
  PURGE_CASCADE_EXCLUSIONS,
};
