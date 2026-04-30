'use strict';

/**
 * Sprint 4 — Restore Engine
 * Cross-Site Custom Field ID Mapping Service.
 *
 * Implements the mapping algorithm from restore-engine-architecture.md §5.
 * Jira custom field IDs are site-scoped; cross-site restores require translating
 * source field IDs to their equivalents on the target site by name matching.
 */

const db = require('../db');

/**
 * Build a source→target custom field ID mapping for a cross-site restore.
 *
 * Algorithm:
 * 1. Fetch target site field definitions from db (production: GET /rest/api/3/field).
 * 2. Match source fields by name (case-insensitive) against target fields.
 * 3. Populate fieldMap for matched fields.
 * 4. Classify unmatched fields as missingRequired or missingOptional.
 * 5. Set status: 'blocked' | 'warn' | 'ok'.
 *
 * @param {{ sourceSiteId: string, targetSiteId: string, sourceFieldIds: string[], requiredFieldIds?: string[] }} input
 *   requiredFieldIds: field IDs that are required (not present → blocks restore). Defaults to [].
 * @returns {{ fieldMap: object, missingRequired: string[], missingOptional: string[], status: string }}
 */
function buildFieldMap(input) {
  const { sourceSiteId, targetSiteId, sourceFieldIds, requiredFieldIds = [] } = input;

  const fieldMap = {};
  const missingRequired = [];
  const missingOptional = [];

  // Build source field name lookup: fieldId → name
  const sourceFieldNames = new Map();
  for (const [key, field] of db.customFieldDefinitions.entries()) {
    const belongsToSource = field.cloudId === sourceSiteId
      || field.siteId === sourceSiteId
      || key.startsWith(`${sourceSiteId}:`);
    if (belongsToSource) {
      const fieldId = field.fieldId || field.id;
      if (fieldId) sourceFieldNames.set(fieldId, (field.name || '').toLowerCase());
    }
  }

  // Build target field lookup: normalized name → fieldId
  const targetFieldsByName = new Map();
  for (const [key, field] of db.customFieldDefinitions.entries()) {
    const belongsToTarget = field.cloudId === targetSiteId
      || field.siteId === targetSiteId
      || key.startsWith(`${targetSiteId}:`);
    if (belongsToTarget) {
      const name = (field.name || '').toLowerCase();
      const fieldId = field.fieldId || field.id;
      if (name && fieldId) targetFieldsByName.set(name, fieldId);
    }
  }

  for (const sourceFieldId of sourceFieldIds) {
    const sourceName = sourceFieldNames.get(sourceFieldId) || '';
    const targetFieldId = sourceName ? targetFieldsByName.get(sourceName) : undefined;

    if (targetFieldId) {
      fieldMap[sourceFieldId] = targetFieldId;
    } else {
      // If no field definitions loaded (simulation), map to self
      if (db.customFieldDefinitions.size === 0) {
        fieldMap[sourceFieldId] = sourceFieldId;
        continue;
      }
      if (requiredFieldIds.includes(sourceFieldId)) {
        missingRequired.push(sourceFieldId);
      } else {
        missingOptional.push(sourceFieldId);
      }
    }
  }

  let status = 'ok';
  if (missingRequired.length > 0) {
    status = 'blocked';
  } else if (missingOptional.length > 0) {
    status = 'warn';
  }

  return { fieldMap, missingRequired, missingOptional, status };
}

module.exports = { buildFieldMap };
