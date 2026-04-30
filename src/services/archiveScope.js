'use strict';

const db = require('../db');

/**
 * Apply archive scope attributes to a JiraProjectNode.
 * Sets archivedFlag=true when project.archived === true.
 * @param {string} integrationId
 * @param {object} project  Raw Jira project object
 */
function tagProjectNode(integrationId, project) {
  const nodeKey = `${integrationId}:${project.key}`;
  const existing = db.projectNodes.get(nodeKey) || {};
  db.projectNodes.set(nodeKey, {
    ...existing,
    integrationId,
    projectKey: project.key,
    projectId: project.id,
    name: project.name,
    archived: project.archived === true,
    raw: project,
    upsertedAt: new Date().toISOString(),
  });
}

/**
 * Apply archive scope attributes to issues already ingested for this integration.
 * Sets statusCategory from issue.fields.status.statusCategory.key (lowercased).
 * Called after paginateAllIssues has stored issueNodes.
 * @param {string} integrationId
 * @param {object[]} issues  Raw Jira issue objects
 */
function tagIssueNodes(integrationId, issues) {
  for (const issue of issues) {
    const nodeKey = `${integrationId}:${issue.key}`;
    const existing = db.issueNodes.get(nodeKey);
    if (!existing) continue;

    const statusCatKey =
      issue.fields &&
      issue.fields.status &&
      issue.fields.status.statusCategory &&
      issue.fields.status.statusCategory.key;

    existing.statusCategory = statusCatKey ? statusCatKey.toLowerCase() : null;
    db.issueNodes.set(nodeKey, existing);
  }
}

/**
 * Apply archive scope attributes to a JiraSprintNode.
 * Sets state from sprint.state (already lowercase from Jira API).
 * Only called when read:board-scope:jira-software is present.
 * @param {string} integrationId
 * @param {object} sprint  Raw Jira sprint object
 */
function tagSprintNode(integrationId, sprint) {
  const nodeKey = `${integrationId}:${sprint.id}`;
  const existing = db.sprintNodes.get(nodeKey) || {};
  db.sprintNodes.set(nodeKey, {
    ...existing,
    integrationId,
    sprintId: sprint.id,
    name: sprint.name,
    state: sprint.state || null,
    raw: sprint,
    upsertedAt: new Date().toISOString(),
  });
}

module.exports = {
  tagProjectNode,
  tagIssueNodes,
  tagSprintNode,
};
