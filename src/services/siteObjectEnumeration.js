'use strict';

const db = require('../db');

const JIRA_API_BASE = 'https://api.atlassian.com/ex/jira';
const WORKFLOW_PAGE_SIZE = 50;
const CONTEXT_PAGE_SIZE = 50;
const OPTIONS_PAGE_SIZE = 100;
const CONTEXT_OPTIONS_CONCURRENCY = 5;

// Field types that have option enumerations
const OPTION_FIELD_TYPES = new Set(['select', 'multiselect', 'radiobuttons', 'checkboxes']);

/**
 * Paginate a Jira API endpoint that uses { values, isLast } pagination.
 * @param {string} url
 * @param {import('axios').AxiosInstance} jiraAxios  Shared instance with 401 interceptor
 * @param {number} pageSize
 * @param {object} extraParams
 * @returns {Promise<object[]>} All values
 */
async function paginateWithIsLast(url, jiraAxios, pageSize, extraParams = {}) {
  const allValues = [];
  let startAt = 0;

  while (true) {
    const response = await jiraAxios.get(url, {
      params: { startAt, maxResults: pageSize, ...extraParams },
    });
    const { values = [], isLast } = response.data;
    allValues.push(...values);
    startAt += values.length || pageSize;
    if (isLast || values.length === 0) break;
  }

  return allValues;
}

/**
 * Enumerate all JiraWorkflowNode objects for a cloudId.
 * GET /rest/api/3/workflow/search — paginated with isLast.
 * @param {string} cloudId
 * @param {import('axios').AxiosInstance} jiraAxios
 * @returns {Promise<object[]>}
 */
async function enumerateWorkflows(cloudId, jiraAxios) {
  const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/workflow/search`;
  const workflows = await paginateWithIsLast(url, jiraAxios, WORKFLOW_PAGE_SIZE);

  for (const workflow of workflows) {
    const nodeKey = `${cloudId}:${workflow.id || workflow.name}`;
    db.workflowNodes.set(nodeKey, {
      cloudId,
      workflowId: workflow.id || workflow.name,
      name: workflow.name,
      raw: workflow,
      upsertedAt: new Date().toISOString(),
    });
  }

  return workflows;
}

/**
 * Enumerate all JiraCustomFieldDefinitionNode objects for a cloudId.
 * GET /rest/api/3/field — single response (no pagination).
 * @param {string} cloudId
 * @param {import('axios').AxiosInstance} jiraAxios
 * @returns {Promise<object[]>}
 */
async function enumerateCustomFields(cloudId, jiraAxios) {
  const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/field`;
  const response = await jiraAxios.get(url);
  const fields = response.data || [];

  for (const field of fields) {
    const nodeKey = `${cloudId}:${field.id}`;
    db.customFieldDefinitions.set(nodeKey, {
      cloudId,
      fieldId: field.id,
      name: field.name,
      schema: field.schema || null,
      fieldType: (field.schema && field.schema.type) || null,
      raw: field,
      upsertedAt: new Date().toISOString(),
    });
  }

  return fields;
}

/**
 * Enumerate contexts and options for a single custom field.
 * @param {string} cloudId
 * @param {import('axios').AxiosInstance} jiraAxios
 * @param {string} fieldId
 * @param {string|null} fieldType  Used to decide whether to enumerate options
 * @returns {Promise<object[]>} context node records stored
 */
async function enumerateCustomFieldContexts(cloudId, jiraAxios, fieldId, fieldType) {
  const ctxUrl = `${JIRA_API_BASE}/${cloudId}/rest/api/3/field/${fieldId}/context`;
  let contexts;
  try {
    contexts = await paginateWithIsLast(ctxUrl, jiraAxios, CONTEXT_PAGE_SIZE);
  } catch (err) {
    if (err.isAxiosError && err.response && err.response.status === 404) {
      console.debug(`[siteObjectEnumeration] Skipping context enumeration for field ${fieldId}: 404 Not Found (system field or no context endpoint)`);
      return [];
    }
    throw err;
  }
  const contextNodes = [];

  // Enumerate options concurrently with max concurrency 5
  const shouldEnumerateOptions = OPTION_FIELD_TYPES.has(fieldType);

  // Process contexts in chunks of CONTEXT_OPTIONS_CONCURRENCY
  for (let i = 0; i < contexts.length; i += CONTEXT_OPTIONS_CONCURRENCY) {
    const chunk = contexts.slice(i, i + CONTEXT_OPTIONS_CONCURRENCY);
    await Promise.all(
      chunk.map(async (ctx) => {
        let options = [];
        if (shouldEnumerateOptions) {
          const optUrl = `${JIRA_API_BASE}/${cloudId}/rest/api/3/field/${fieldId}/context/option`;
          options = await paginateWithIsLast(optUrl, jiraAxios, OPTIONS_PAGE_SIZE, {
            contextId: ctx.id,
          });
        }

        const nodeKey = `${cloudId}:${fieldId}:${ctx.id}`;
        const node = {
          cloudId,
          fieldId,
          contextId: ctx.id,
          name: ctx.name,
          isGlobalContext: ctx.isGlobalContext || false,
          options,
          raw: ctx,
          upsertedAt: new Date().toISOString(),
        };
        db.customFieldContextNodes.set(nodeKey, node);
        contextNodes.push(node);
      })
    );
  }

  return contextNodes;
}

/**
 * Run the full site-level object enumeration for a cloudId.
 * Order: workflows + custom fields (concurrent), then contexts (gated on fields).
 * @param {string} cloudId
 * @param {import('axios').AxiosInstance} jiraAxios  Shared instance with 401 interceptor
 * @returns {Promise<{workflows: object[], fields: object[], contextNodes: object[]}>}
 */
async function runSiteEnumeration(cloudId, jiraAxios) {
  // Step 1+2: workflows and field definitions run concurrently
  const [workflows, fields] = await Promise.all([
    enumerateWorkflows(cloudId, jiraAxios),
    enumerateCustomFields(cloudId, jiraAxios),
  ]);

  // Step 3: contexts enumerated per custom field only (gated on step 2 completion)
  // System fields (those without 'customfield_' prefix) do not support the /context endpoint
  const customFields = fields.filter((field) => field.id && field.id.startsWith('customfield_'));
  const allContextNodes = [];
  for (let i = 0; i < customFields.length; i += CONTEXT_OPTIONS_CONCURRENCY) {
    const chunk = customFields.slice(i, i + CONTEXT_OPTIONS_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((field) => {
        const fieldType = (field.schema && field.schema.type) || null;
        return enumerateCustomFieldContexts(cloudId, jiraAxios, field.id, fieldType);
      })
    );
    for (const nodes of results) {
      allContextNodes.push(...nodes);
    }
  }

  return { workflows, fields, contextNodes: allContextNodes };
}

module.exports = {
  enumerateWorkflows,
  enumerateCustomFields,
  enumerateCustomFieldContexts,
  runSiteEnumeration,
};
