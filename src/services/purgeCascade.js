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

/**
 * Filter a purge cascade basket, silently removing excluded node types.
 * Emits a structured exclusion log entry (PURGE_CASCADE_EXCLUSION) for each
 * excluded item. Does not throw — callers receive the filtered allowed list.
 *
 * @param {Array<{ nodeType: string, targetId?: string, [key: string]: any }>} basket
 * @returns {{
 *   allowed: Array<{ nodeType: string, targetId: string|null }>,
 *   excluded: Array<{ nodeType: string, targetId: string|null }>,
 *   exclusionLog: Array<{ event: string, nodeType: string, targetId: string|null, reason: string, timestamp: string }>
 * }}
 */
function filterPurgeCascadeBasket(basket) {
  const allowed = [];
  const excluded = [];
  const exclusionLog = [];

  for (const item of basket) {
    if (PURGE_EXCLUDED_NODE_TYPES.has(item.nodeType)) {
      const entry = {
        event: 'PURGE_CASCADE_EXCLUSION',
        nodeType: item.nodeType,
        targetId: item.targetId || null,
        reason: `Node type "${item.nodeType}" is excluded from purge cascade (site-scoped object protection).`,
        timestamp: new Date().toISOString(),
      };
      excluded.push({ nodeType: item.nodeType, targetId: item.targetId || null });
      exclusionLog.push(entry);
      console.log(JSON.stringify(entry));
    } else {
      allowed.push({ nodeType: item.nodeType, targetId: item.targetId || null });
    }
  }

  return { allowed, excluded, exclusionLog };
}

module.exports = {
  PURGE_EXCLUDED_NODE_TYPES,
  assertPurgeCascadeAllowed,
  isPurgeCascadeExcluded,
  filterPurgeCascadeBasket,
};
