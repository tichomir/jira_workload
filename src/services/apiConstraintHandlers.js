'use strict';

/**
 * Sprint 4 — Restore Engine
 * Permanent API Constraint Handlers.
 *
 * These handlers are always applied during restore; they cannot be disabled by configuration.
 * Implements the four permanent constraints from restore-engine-architecture.md §7.
 */

const { ISSUE_KEY_LABEL_PREFIX, REPORTER_ATTRIBUTION_HEADER, COMMENT_AUTHOR_ADF_NODE } =
  require('../config/restoreConstants');

// ── 1. Issue Key Label Stamping ───────────────────────────────────────────────

/**
 * Inject original-key:{originalKey} label into the issue create/update payload.
 * Appends to existing labels array; does not overwrite.
 *
 * @param {object} payload - Jira issue create payload. Must contain a `fields` sub-object.
 * @param {string} originalKey - e.g. 'PROJ-123'
 * @returns {object} The same payload object, mutated.
 */
function stampOriginalKeyLabel(payload, originalKey) {
  if (!payload.fields) {
    payload.fields = {};
  }
  if (!Array.isArray(payload.fields.labels)) {
    payload.fields.labels = [];
  }
  const labelValue = `${ISSUE_KEY_LABEL_PREFIX}${originalKey}`;
  if (!payload.fields.labels.includes(labelValue)) {
    payload.fields.labels.push(labelValue);
  }
  return payload;
}

// ── 2. Reporter Attribution Header ───────────────────────────────────────────

/**
 * Prepend reporter attribution header as the first ADF paragraph node in a comment body.
 * Format: "[Restored from backup — original reporter: {displayName} <{emailAddress}>]"
 *
 * @param {object} adfDoc - ADF document { version: 1, type: 'doc', content: [...] }
 * @param {{ displayName: string, emailAddress: string }} originalReporter
 * @returns {object} New ADF document with attribution header prepended.
 */
function injectReporterAttributionHeader(adfDoc, originalReporter) {
  const text = REPORTER_ATTRIBUTION_HEADER
    .replace('{displayName}', originalReporter.displayName)
    .replace('{emailAddress}', originalReporter.emailAddress);

  const headerNode = {
    type: 'paragraph',
    content: [{ type: 'text', text }],
  };

  return {
    version: adfDoc.version,
    type: adfDoc.type,
    content: [headerNode, ...(adfDoc.content || [])],
  };
}

// ── 3. Comment Author ADF Header ──────────────────────────────────────────────

/**
 * Prepend comment author attribution as the first ADF paragraph node in a comment body.
 * Format: "[Original comment by: {authorDisplayName} on {originalCreatedDate}]"
 *
 * Per ADR-004: comment author header is prepended before reporter attribution header,
 * so it is always the outermost (first) node in the ADF document.
 *
 * @param {object} adfDoc - ADF document
 * @param {{ displayName: string, accountId: string }} author
 * @param {string} originalCreatedDate - ISO 8601 timestamp
 * @returns {object} New ADF document with author header prepended.
 */
function prependCommentAuthorAdfHeader(adfDoc, author, originalCreatedDate) {
  const templateText = COMMENT_AUTHOR_ADF_NODE.content[0].text;
  const text = templateText
    .replace('{authorDisplayName}', author.displayName)
    .replace('{originalCreatedDate}', originalCreatedDate);

  const headerNode = {
    type: 'paragraph',
    content: [{ type: 'text', text }],
  };

  return {
    version: adfDoc.version,
    type: adfDoc.type,
    content: [headerNode, ...(adfDoc.content || [])],
  };
}

// ── 4. Full Workflow Definition Supply ────────────────────────────────────────

/**
 * Build the full workflow create/update payload from a backup workflow node.
 * Always supplies the complete workflow definition; partial/property-level updates
 * are permanently excluded (ADR-003).
 *
 * @param {object} backupWorkflow - JiraWorkflowNode from the backup store.
 *   Must contain a `definition` field with the full Jira workflow JSON.
 * @returns {object} Full workflow create/update payload.
 * @throws {Error} with code WORKFLOW_DEFINITION_MISSING if definition is absent.
 */
function buildWorkflowRestorePayload(backupWorkflow) {
  if (!backupWorkflow) {
    const err = new Error('Workflow definition is missing from backup store');
    err.code = 'WORKFLOW_DEFINITION_MISSING';
    throw err;
  }

  // Handle legacy format where the full definition is nested under a `definition` key.
  if (backupWorkflow.definition && typeof backupWorkflow.definition === 'object') {
    return backupWorkflow.definition;
  }

  // Raw Jira API workflow format: the Jira workflow search endpoint returns
  //   { id: { name, entityId, draft }, name, description, statuses, transitions, ... }
  // statuses and transitions are directly on the object.
  const name = backupWorkflow.name
    || (backupWorkflow.id && typeof backupWorkflow.id === 'object' && backupWorkflow.id.name);
  const statuses = backupWorkflow.statuses;
  const transitions = backupWorkflow.transitions;

  if (!name || !Array.isArray(statuses) || !Array.isArray(transitions)) {
    const err = new Error('Workflow definition is missing from backup store');
    err.code = 'WORKFLOW_DEFINITION_MISSING';
    throw err;
  }

  // Return the complete workflow definition payload for the Jira REST API v3.
  return {
    name,
    description: backupWorkflow.description || '',
    statuses,
    transitions,
  };
}

module.exports = {
  stampOriginalKeyLabel,
  injectReporterAttributionHeader,
  prependCommentAuthorAdfHeader,
  buildWorkflowRestorePayload,
};
