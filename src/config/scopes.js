'use strict';

/**
 * Authoritative Atlassian OAuth 2.0 delegated scope manifest.
 *
 * This is the single source of truth consumed by:
 *   - The OAuth connect URL builder (express + manual paths)
 *   - The scope-validation step after token exchange
 *   - The pre-restore Jira Software Active check
 *
 * 21 scopes total: 19 required + 2 optional (both board-scope variants).
 * The two optional scopes degrade gracefully: their absence disables board/sprint
 * backup and restore but does not block the connection.
 */

const SCOPE_MANIFEST = [
  // ── Authentication ──────────────────────────────────────────────────────────
  {
    scope: 'offline_access',
    required: true,
    severity: 'FATAL',
    affectedFeatures: ['persistent_connection', 'token_refresh'],
    backupStages: ['all'],
    restoreStages: ['all'],
    remediationMessage:
      "Offline access is required for long-lived connections. Re-authorize and ensure 'Keep me logged in' / offline_access is granted.",
  },

  // ── Issues (classic + granular) ──────────────────────────────────────────────
  {
    scope: 'read:jira-work',
    required: true,
    severity: 'CRITICAL',
    affectedFeatures: ['issues', 'comments', 'worklogs', 'attachments'],
    backupStages: ['JQL enumeration', 'issue snapshot'],
    restoreStages: [],
    remediationMessage:
      "Issue read access is required. In your Atlassian app settings, verify 'Read Jira work data' is enabled.",
  },
  {
    scope: 'write:jira-work',
    required: true,
    severity: 'CRITICAL',
    affectedFeatures: ['create_issues', 'update_issues', 'add_comments', 'log_work'],
    backupStages: [],
    restoreStages: ['Stage 3 — issue create/update', 'Stage 4a — comment restore'],
    remediationMessage:
      "Issue write access is required. Enable 'Write Jira work data' permission in your Atlassian app.",
  },
  {
    scope: 'read:issue:jira',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['granular_issue_read'],
    backupStages: ['JQL enumeration', 'issue snapshot'],
    restoreStages: ['Stage 3 — existing-issue lookup by key'],
    remediationMessage:
      "Granular issue read scope missing. Re-authorize; ensure your Atlassian app requests 'read:issue:jira'.",
  },
  {
    scope: 'write:issue:jira',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['granular_issue_write'],
    backupStages: [],
    restoreStages: ['Stage 3 — issue create/update'],
    remediationMessage:
      "Granular issue write scope missing. Re-authorize with 'write:issue:jira' enabled.",
  },
  {
    scope: 'read:issue-type:jira',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['issue_type_schemes', 'issue_type_filters'],
    backupStages: ['issue type enumeration'],
    restoreStages: ['Stage 3 — issue create (issuetype validation)'],
    remediationMessage:
      "Issue type read access missing. Issue type filters will be unavailable. Re-authorize with 'read:issue-type:jira'.",
  },

  // ── Projects ─────────────────────────────────────────────────────────────────
  {
    scope: 'read:project:jira',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['project_list', 'project_metadata'],
    backupStages: ['project enumeration'],
    restoreStages: ['Stage 2 — target project existence check'],
    remediationMessage:
      "Project read access missing. Re-authorize with 'read:project:jira' enabled.",
  },
  {
    scope: 'write:project:jira',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['create_projects', 'update_projects'],
    backupStages: [],
    restoreStages: ['Stage 2 — project create/update'],
    remediationMessage:
      "Project write scope missing. Re-authorize with 'write:project:jira' enabled.",
  },
  {
    scope: 'manage:jira-project',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['project_config', 'components', 'versions'],
    backupStages: ['project config snapshot'],
    restoreStages: ['Stage 2 — project config restore'],
    remediationMessage:
      "Project management access is required. Enable 'Manage Jira projects' in your Atlassian app.",
  },

  // ── Users ────────────────────────────────────────────────────────────────────
  {
    scope: 'read:jira-user',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['user_profiles', 'assignees', 'reporters'],
    backupStages: ['user profile resolution'],
    restoreStages: [],
    remediationMessage:
      "User read access is required to display assignee and reporter data. Enable 'Read Jira user data' in your Atlassian app.",
  },
  {
    scope: 'read:user:jira',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['user_accounts', 'groups', 'teams'],
    backupStages: ['assignee/reporter resolution'],
    restoreStages: [],
    remediationMessage:
      "Granular user read scope missing. Re-authorize with 'read:user:jira' enabled.",
  },

  // ── Custom Fields ─────────────────────────────────────────────────────────────
  {
    scope: 'read:field:jira',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['custom_fields', 'system_fields'],
    backupStages: ['JiraCustomFieldDefinitionNode enumeration', 'JiraCustomFieldContextNode enumeration'],
    restoreStages: ['Stage 1 — custom field presence validation'],
    remediationMessage:
      "Field read access missing. Custom field data will be unavailable. Re-authorize with 'read:field:jira'.",
  },
  {
    scope: 'write:field:jira',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['field_value_updates'],
    backupStages: [],
    restoreStages: ['Stage 1 — custom field definition restore', 'Stage 3 — issue custom field values restore'],
    remediationMessage:
      "Field write scope missing. Issue field updates will fail. Re-authorize with 'write:field:jira'.",
  },

  // ── Workflows ─────────────────────────────────────────────────────────────────
  {
    scope: 'manage:jira-configuration',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['workflow_config', 'issue_type_config', 'field_config'],
    backupStages: ['JiraWorkflowNode enumeration'],
    restoreStages: ['Stage 1 — workflow restore (full definition)'],
    remediationMessage:
      "Configuration read access is required. Enable 'Manage Jira configuration' in your Atlassian app.",
  },

  // ── Epics ─────────────────────────────────────────────────────────────────────
  {
    scope: 'read:epic:jira-software',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['epic_hierarchy', 'epic_reporting'],
    backupStages: ['epic snapshot'],
    restoreStages: [],
    remediationMessage:
      "Epic read access missing. Epic-level reporting disabled. Re-authorize with 'read:epic:jira-software'.",
  },
  {
    scope: 'write:epic:jira-software',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['epic_management', 'epic_assignments'],
    backupStages: [],
    restoreStages: ['Stage 3 — epic assignment restore'],
    remediationMessage:
      "Epic write scope missing. Epic management disabled. Re-authorize with 'write:epic:jira-software'.",
  },

  // ── Sprints ───────────────────────────────────────────────────────────────────
  {
    scope: 'read:sprint:jira-software',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['sprint_data', 'sprint_reporting'],
    backupStages: ['Sprint enumeration via Agile API'],
    restoreStages: [],
    remediationMessage:
      "Sprint read access missing. Sprint reporting will be unavailable. Re-authorize with 'read:sprint:jira-software'.",
  },
  {
    scope: 'write:sprint:jira-software',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['sprint_management', 'move_issues_between_sprints'],
    backupStages: [],
    restoreStages: ['Stage 5 — sprint create and sprint→issue assignment'],
    remediationMessage:
      "Sprint write scope missing. Sprint management features disabled. Re-authorize with 'write:sprint:jira-software'.",
  },

  // ── Webhooks ──────────────────────────────────────────────────────────────────
  {
    scope: 'manage:jira-webhook',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['webhooks', 'real_time_sync'],
    backupStages: ['dynamic webhook registration (issue_created, issue_updated, issue_deleted)'],
    restoreStages: [],
    remediationMessage:
      "Webhook access is required for real-time sync. Enable 'Manage Jira webhooks' in your Atlassian app.",
  },

  // ── Boards (optional — graceful degradation) ──────────────────────────────────
  {
    scope: 'read:board-scope:jira-software',
    required: false,
    severity: 'WARNING',
    affectedFeatures: ['boards', 'board_config', 'kanban_views', 'scrum_boards'],
    backupStages: ['Board enumeration via Agile API'],
    restoreStages: [],
    remediationMessage:
      "Board read scope not granted. Board and Kanban views are disabled. This is non-blocking — Issue and Project data will continue to sync. To enable board backup and restore, reconnect and grant 'read:board-scope:jira-software' and 'write:board-scope:jira-software'.",
  },
  {
    scope: 'write:board-scope:jira-software',
    required: false,
    severity: 'WARNING',
    affectedFeatures: ['board_restore', 'sprint_restore', 'board_create', 'sprint_create'],
    backupStages: [],
    restoreStages: ['Stage 4b — board create/update', 'Stage 5 — sprint create on board'],
    remediationMessage:
      "Board write scope not granted. Board and sprint restore is disabled. To enable board and sprint restore, reconnect and grant 'write:board-scope:jira-software'.",
  },
];

/**
 * All scope names as an array (preserves declaration order).
 */
const SCOPE_NAMES = SCOPE_MANIFEST.map((s) => s.scope);

/**
 * Space-delimited scope string for the OAuth authorization URL.
 */
const SCOPE_STRING = SCOPE_NAMES.join(' ');

/**
 * Set of optional scope names (for quick lookup).
 */
const OPTIONAL_SCOPES = new Set(
  SCOPE_MANIFEST.filter((s) => !s.required).map((s) => s.scope),
);

/**
 * Board-related optional scopes — absence triggers DEGRADED (not FAIL).
 */
const BOARD_SCOPES = new Set([
  'read:board-scope:jira-software',
  'write:board-scope:jira-software',
]);

module.exports = {
  SCOPE_MANIFEST,
  SCOPE_NAMES,
  SCOPE_STRING,
  OPTIONAL_SCOPES,
  BOARD_SCOPES,
};
