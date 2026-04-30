'use strict';

/**
 * Node types excluded from purge cascade at the platform layer.
 * Site-scoped objects shared across all projects in a cloudId must not be
 * deleted as a side-effect of project-scoped or backup-point-scoped purges.
 */
const PURGE_EXCLUDED_NODE_TYPES = new Set([
  'JiraWorkflowNode',
  'JiraCustomFieldDefinitionNode',
  'JiraCustomFieldContextNode',
]);

/**
 * Validate that a purge cascade request does not target an excluded node type.
 * Throws an error with code PURGE_CASCADE_BOUNDARY_VIOLATION if the check fails.
 *
 * @param {string} nodeType  The target node type for the cascade operation
 * @throws {{ code: string, message: string, status: number }}
 */
function assertPurgeCascadeAllowed(nodeType) {
  if (PURGE_EXCLUDED_NODE_TYPES.has(nodeType)) {
    const err = new Error(
      `Purge cascade is not allowed for node type "${nodeType}". ` +
      'Site-scoped objects are excluded from project-level purge cascades.'
    );
    err.code = 'PURGE_CASCADE_BOUNDARY_VIOLATION';
    err.status = 409;
    throw err;
  }
}

/**
 * Check if a node type is in the purge exclusion list.
 * @param {string} nodeType
 * @returns {boolean}
 */
function isPurgeCascadeExcluded(nodeType) {
  return PURGE_EXCLUDED_NODE_TYPES.has(nodeType);
}

module.exports = {
  PURGE_EXCLUDED_NODE_TYPES,
  assertPurgeCascadeAllowed,
  isPurgeCascadeExcluded,
};
