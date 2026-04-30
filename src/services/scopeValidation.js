'use strict';

/**
 * 20-scope permission validation matrix.
 * Validates granted scopes against required and optional scopes,
 * returning per-scope pass/fail with remediation messages.
 */

const { v4: uuidv4 } = require('uuid');

const SCOPE_MATRIX = [
  {
    scope: 'offline_access',
    required: true,
    severity: 'FATAL',
    affectedFeatures: ['persistent_connection', 'token_refresh'],
    remediationMessage: "Offline access is required for long-lived connections. Re-authorize and ensure 'Keep me logged in' / offline_access is granted.",
  },
  {
    scope: 'read:jira-work',
    required: true,
    severity: 'CRITICAL',
    affectedFeatures: ['issues', 'comments', 'worklogs', 'attachments'],
    remediationMessage: "Issue read access is required. In your Atlassian app settings, verify 'Read Jira work data' is enabled.",
  },
  {
    scope: 'write:jira-work',
    required: true,
    severity: 'CRITICAL',
    affectedFeatures: ['create_issues', 'update_issues', 'add_comments', 'log_work'],
    remediationMessage: "Issue write access is required. Enable 'Write Jira work data' permission in your Atlassian app.",
  },
  {
    scope: 'read:jira-user',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['user_profiles', 'assignees', 'reporters'],
    remediationMessage: "User read access is required to display assignee and reporter data. Enable 'Read Jira user data' in your Atlassian app.",
  },
  {
    scope: 'manage:jira-project',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['project_config', 'components', 'versions'],
    remediationMessage: "Project management access is required. Enable 'Manage Jira projects' in your Atlassian app.",
  },
  {
    scope: 'manage:jira-configuration',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['workflow_config', 'issue_type_config', 'field_config'],
    remediationMessage: "Configuration read access is required. Enable 'Manage Jira configuration' in your Atlassian app.",
  },
  {
    scope: 'manage:jira-webhook',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['webhooks', 'real_time_sync'],
    remediationMessage: "Webhook access is required for real-time sync. Enable 'Manage Jira webhooks' in your Atlassian app.",
  },
  {
    scope: 'read:issue:jira',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['granular_issue_read'],
    remediationMessage: "Granular issue read scope missing. Re-authorize; ensure your Atlassian app requests 'read:issue:jira'.",
  },
  {
    scope: 'write:issue:jira',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['granular_issue_write'],
    remediationMessage: "Granular issue write scope missing. Re-authorize with 'write:issue:jira' enabled.",
  },
  {
    scope: 'read:project:jira',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['project_list', 'project_metadata'],
    remediationMessage: "Project read access missing. Re-authorize with 'read:project:jira' enabled.",
  },
  {
    scope: 'write:project:jira',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['create_projects', 'update_projects'],
    remediationMessage: "Project write scope missing. Re-authorize with 'write:project:jira' enabled.",
  },
  {
    scope: 'read:user:jira',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['user_accounts', 'groups', 'teams'],
    remediationMessage: "Granular user read scope missing. Re-authorize with 'read:user:jira' enabled.",
  },
  {
    scope: 'read:field:jira',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['custom_fields', 'system_fields'],
    remediationMessage: "Field read access missing. Custom field data will be unavailable. Re-authorize with 'read:field:jira'.",
  },
  {
    scope: 'write:field:jira',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['field_value_updates'],
    remediationMessage: "Field write scope missing. Issue field updates will fail. Re-authorize with 'write:field:jira'.",
  },
  {
    scope: 'read:sprint:jira-software',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['sprint_data', 'sprint_reporting'],
    remediationMessage: "Sprint read access missing. Sprint reporting will be unavailable. Re-authorize with 'read:sprint:jira-software'.",
  },
  {
    scope: 'write:sprint:jira-software',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['sprint_management', 'move_issues_between_sprints'],
    remediationMessage: "Sprint write scope missing. Sprint management features disabled. Re-authorize with 'write:sprint:jira-software'.",
  },
  {
    scope: 'read:epic:jira-software',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['epic_hierarchy', 'epic_reporting'],
    remediationMessage: "Epic read access missing. Epic-level reporting disabled. Re-authorize with 'read:epic:jira-software'.",
  },
  {
    scope: 'write:epic:jira-software',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['epic_management', 'epic_assignments'],
    remediationMessage: "Epic write scope missing. Epic management disabled. Re-authorize with 'write:epic:jira-software'.",
  },
  {
    scope: 'read:issue-type:jira',
    required: true,
    severity: 'ERROR',
    affectedFeatures: ['issue_type_schemes', 'issue_type_filters'],
    remediationMessage: "Issue type read access missing. Issue type filters will be unavailable. Re-authorize with 'read:issue-type:jira'.",
  },
  {
    scope: 'read:board-scope:jira-software',
    required: false,
    severity: 'WARNING',
    affectedFeatures: ['boards', 'board_config', 'kanban_views', 'scrum_boards'],
    remediationMessage: "Board access scope not granted. Board and Kanban views are disabled. This is non-blocking — Issue and Project data will continue to sync. To enable boards, re-authorize and grant 'read:board-scope:jira-software'.",
  },
];

const SCOPE_NAMES = SCOPE_MATRIX.map((s) => s.scope);

/**
 * Returns the full scope string for the authorization URL.
 */
function getScopeString() {
  return SCOPE_NAMES.join(' ');
}

/**
 * Validate granted scopes against the 20-scope matrix.
 * @param {string[]} grantedScopes - Array of scope strings from the token response
 * @param {string} connectionId - OAuthConnection ID
 * @param {string} cloudId - Atlassian cloudId
 * @returns {object} ScopeValidationResult
 */
function validateScopes(grantedScopes, connectionId, cloudId) {
  const grantedSet = new Set(grantedScopes);

  const entries = SCOPE_MATRIX.map((def) => {
    const granted = grantedSet.has(def.scope);
    return {
      scope: def.scope,
      required: def.required,
      granted,
      severity: granted ? 'OK' : def.severity,
      remediationMessage: granted ? null : def.remediationMessage,
      affectedFeatures: granted ? [] : def.affectedFeatures,
    };
  });

  const missingRequired = entries.filter((e) => e.required && !e.granted).map((e) => e.scope);
  const missingOptional = entries.filter((e) => !e.required && !e.granted).map((e) => e.scope);
  const boardScopeMissing = missingOptional.includes('read:board-scope:jira-software');

  const degradedFeatures = entries
    .filter((e) => !e.required && !e.granted)
    .flatMap((e) => e.affectedFeatures);

  let overallStatus;
  let connectionAllowed;

  if (missingRequired.length > 0) {
    overallStatus = 'FAIL';
    connectionAllowed = false;
  } else if (boardScopeMissing) {
    overallStatus = 'DEGRADED';
    connectionAllowed = true;
  } else {
    overallStatus = 'PASS';
    connectionAllowed = true;
  }

  return {
    id: uuidv4(),
    connectionId: connectionId || null,
    cloudId: cloudId || null,
    overallStatus,
    connectionAllowed,
    entries,
    grantedScopes: [...grantedSet],
    missingRequiredScopes: missingRequired,
    missingOptionalScopes: missingOptional,
    degradedFeatures,
    validatedAt: new Date().toISOString(),
  };
}

module.exports = { SCOPE_MATRIX, SCOPE_NAMES, getScopeString, validateScopes };
