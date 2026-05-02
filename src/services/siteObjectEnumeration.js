'use strict';

const db = require('../db');
const { PHASES, emitProgress } = require('./jobProgress');

const JIRA_API_BASE = 'https://api.atlassian.com/ex/jira';
const AGILE_API_BASE = 'https://api.atlassian.com/ex/jira';
const WORKFLOW_PAGE_SIZE = 50;
const CONTEXT_PAGE_SIZE = 50;
const OPTIONS_PAGE_SIZE = 100;
const CONTEXT_OPTIONS_CONCURRENCY = 5;
const BOARD_PAGE_SIZE = 50;
const SPRINT_PAGE_SIZE = 50;

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
  console.info(`[siteEnum] enumerating workflows for cloudId=${cloudId}`);
  const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/workflow/search`;
  const workflows = await paginateWithIsLast(url, jiraAxios, WORKFLOW_PAGE_SIZE);
  console.info(`[siteEnum] workflows enumerated: count=${workflows.length}`);

  for (const workflow of workflows) {
    // workflow.id from Jira workflow search API is { name, entityId, draft } — extract scalar
    const wfId = (workflow.id && typeof workflow.id === 'object')
      ? (workflow.id.entityId || workflow.id.name || workflow.name)
      : (workflow.id || workflow.name);
    const nodeKey = `${cloudId}:${wfId}`;
    db.workflowNodes.set(nodeKey, {
      cloudId,
      workflowId: wfId,
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
  console.info(`[siteEnum] enumerating custom fields for cloudId=${cloudId}`);
  const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/field`;
  const response = await jiraAxios.get(url);
  const fields = response.data || [];
  console.info(`[siteEnum] custom fields enumerated: count=${fields.length}`);

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
 * Paginate a Jira Agile API endpoint that uses { values, isLast } or { values, total } pagination.
 * @param {string} url
 * @param {import('axios').AxiosInstance} jiraAxios
 * @param {number} pageSize
 * @param {object} extraParams
 * @returns {Promise<object[]>}
 */
async function paginateAgile(url, jiraAxios, pageSize, extraParams = {}) {
  const allValues = [];
  let startAt = 0;

  while (true) {
    let response;
    try {
      response = await jiraAxios.get(url, {
        params: { startAt, maxResults: pageSize, ...extraParams },
      });
    } catch (err) {
      if (err.isAxiosError && err.response && (err.response.status === 404 || err.response.status === 400)) {
        console.debug(`[siteEnum] Agile pagination skipped for ${url}: ${err.response.status}`);
        return allValues;
      }
      throw err;
    }
    const data = response.data || {};
    const values = data.values || [];
    allValues.push(...values);
    startAt += values.length || pageSize;
    if (data.isLast || values.length === 0) break;
    // total-based termination fallback
    if (typeof data.total === 'number' && allValues.length >= data.total) break;
  }

  return allValues;
}

/**
 * Enumerate all JiraBoardNode and JiraSprintNode objects for an integration.
 * GET /rest/agile/1.0/board — paginated; then for scrum boards GET /rest/agile/1.0/board/{id}/sprint
 * @param {string} integrationId
 * @param {string} cloudId
 * @param {import('axios').AxiosInstance} jiraAxios
 * @returns {Promise<{boards: object[], sprints: object[]}>}
 */
async function enumerateBoards(integrationId, cloudId, jiraAxios) {
  console.info(`[siteEnum] enumerating boards for cloudId=${cloudId}`);
  const boardUrl = `${AGILE_API_BASE}/${cloudId}/rest/agile/1.0/board`;
  const boards = await paginateAgile(boardUrl, jiraAxios, BOARD_PAGE_SIZE);
  console.info(`[siteEnum] boards enumerated: count=${boards.length}`);

  const allSprints = [];

  for (const board of boards) {
    // Fetch board configuration to capture filterJql and columnConfig
    let config = {};
    try {
      const configUrl = `${AGILE_API_BASE}/${cloudId}/rest/agile/1.0/board/${board.id}/configuration`;
      const configResp = await jiraAxios.get(configUrl);
      config = configResp.data || {};
    } catch (err) {
      console.debug(`[siteEnum] board config fetch skipped for boardId=${board.id}: ${err.message}`);
    }

    const nodeKey = `${cloudId}:${board.id}`;
    db.sprintNodes.set(nodeKey, {
      cloudId,
      integrationId,
      boardId: board.id,
      name: board.name,
      type: board.type,
      projectKey: (board.location && board.location.projectKey) || null,
      filterJql: config.filter && config.filter.query || null,
      columnConfig: config.columnConfig || null,
      raw: board,
      upsertedAt: new Date().toISOString(),
    });

    // Only scrum boards have sprints
    if (board.type === 'scrum') {
      try {
        const sprintUrl = `${AGILE_API_BASE}/${cloudId}/rest/agile/1.0/board/${board.id}/sprint`;
        const sprints = await paginateAgile(sprintUrl, jiraAxios, SPRINT_PAGE_SIZE);
        for (const sprint of sprints) {
          const sprintNodeKey = `${cloudId}:sprint:${sprint.id}`;
          db.sprintNodes.set(sprintNodeKey, {
            cloudId,
            integrationId,
            sprintId: sprint.id,
            boardId: board.id,
            name: sprint.name,
            state: sprint.state,
            startDate: sprint.startDate || null,
            endDate: sprint.endDate || null,
            completeDate: sprint.completeDate || null,
            goal: sprint.goal || null,
            raw: sprint,
            upsertedAt: new Date().toISOString(),
          });
          allSprints.push({ ...sprint, originBoardId: board.id });
        }
      } catch (err) {
        console.debug(`[siteEnum] sprint enumeration skipped for boardId=${board.id}: ${err.message}`);
      }
    }
  }

  console.info(`[siteEnum] sprints enumerated: count=${allSprints.length}`);
  return { boards, sprints: allSprints };
}

/**
 * Run the full site-level object enumeration for a cloudId.
 * Order: workflows + custom fields (concurrent), then contexts (gated on fields), then boards+sprints.
 * @param {string} integrationId
 * @param {string} cloudId
 * @param {import('axios').AxiosInstance} jiraAxios  Shared instance with 401 interceptor
 * @param {string|null} [jobId]  Optional — for phase progress tracking
 * @returns {Promise<{workflows: object[], fields: object[], contextNodes: object[], boards: object[], sprints: object[]}>}
 */
async function runSiteEnumeration(integrationId, cloudId, jiraAxios, jobId = null) {
  // Step 1+2: workflows and field definitions run concurrently
  emitProgress(jobId, { phase: PHASES.WORKFLOW_ENUM, objectType: 'JiraWorkflowNode', objectKey: cloudId });
  const [workflows, fields] = await Promise.all([
    enumerateWorkflows(cloudId, jiraAxios),
    enumerateCustomFields(cloudId, jiraAxios),
  ]);
  emitProgress(jobId, { phase: PHASES.CUSTOM_FIELD_ENUM, objectType: 'JiraCustomFieldDefinitionNode', processed: fields.length });

  // Step 3: contexts enumerated per custom field only (gated on step 2 completion)
  // System fields (those without 'customfield_' prefix) do not support the /context endpoint
  const customFields = fields.filter((field) => field.id && field.id.startsWith('customfield_'));
  console.info(`[siteEnum] enumerating contexts for ${customFields.length} custom fields`);
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

  // Step 4: board and sprint enumeration (non-blocking — requires read:board-scope)
  let boards = [];
  let sprints = [];
  try {
    const boardResult = await enumerateBoards(integrationId, cloudId, jiraAxios);
    boards = boardResult.boards;
    sprints = boardResult.sprints;
  } catch (err) {
    console.warn(`[siteEnum] Board/sprint enumeration failed (non-fatal): ${err.message}`);
  }

  return { workflows, fields, contextNodes: allContextNodes, boards, sprints };
}

module.exports = {
  enumerateWorkflows,
  enumerateCustomFields,
  enumerateCustomFieldContexts,
  enumerateBoards,
  runSiteEnumeration,
};
