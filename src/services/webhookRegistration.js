'use strict';

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const JIRA_API_BASE = 'https://api.atlassian.com/ex/jira';
// Atlassian webhooks expire 30 days after last refresh
const WEBHOOK_EXPIRY_DAYS = 30;
// Schedule renewal 48h before expiry
const RENEWAL_LEAD_HOURS = 48;

const WEBHOOK_EVENTS = ['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted'];

/**
 * Fetch existing webhooks registered for this cloudId from Jira.
 * @param {string} cloudId
 * @param {string} accessToken
 * @returns {Promise<object[]>}
 */
async function fetchExistingWebhooks(cloudId, accessToken) {
  const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/webhook`;
  const response = await axios.get(url, {
    timeout: 15000,
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  return (response.data && response.data.values) || [];
}

/**
 * Register a webhook with Jira for the given integration.
 * @param {string} cloudId
 * @param {string} accessToken
 * @param {string|null} jqlFilter  JQL filter string, or null for all projects
 * @returns {Promise<number>} The Jira-assigned webhook ID
 */
async function registerJiraWebhook(cloudId, accessToken, jqlFilter) {
  const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/webhook`;
  const webhookPayload = {
    url: process.env.WEBHOOK_CALLBACK_URL || `${process.env.APP_BASE_URL || 'http://localhost:3000'}/webhooks/jira`,
    webhooks: [
      {
        events: WEBHOOK_EVENTS,
        ...(jqlFilter ? { jqlFilter } : {}),
      },
    ],
  };
  const response = await axios.post(url, webhookPayload, {
    timeout: 15000,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });
  const results = response.data && response.data.webhookRegistrationResult;
  if (!results || results.length === 0) {
    throw new Error('Jira webhook registration returned no results');
  }
  return results[0].createdWebhookId;
}

/**
 * Build a JQL filter for an integration based on its project scope.
 * @param {object} connection  OAuthConnection record
 * @returns {string|null}
 */
function buildWebhookJqlFilter(connection) {
  if (
    connection.projectScopeMode === 'selected' &&
    connection.selectedProjectIds &&
    connection.selectedProjectIds.length > 0
  ) {
    const keys = connection.selectedProjectIds.join(',');
    return `project in (${keys})`;
  }
  return null; // All projects — Atlassian treats no filter as all projects
}

/**
 * Check if there is an active (non-expired, non-deleted) WebhookRegistration
 * for the given integrationId + cloudId in the local store.
 * @param {string} integrationId
 * @param {string} cloudId
 * @returns {object|null}
 */
function findActiveLocalRegistration(integrationId, cloudId) {
  const now = new Date();
  for (const reg of db.webhookRegistrations.values()) {
    if (
      reg.integrationId === integrationId &&
      reg.cloudId === cloudId &&
      !reg.deletedAt &&
      new Date(reg.expiresAt) > now
    ) {
      return reg;
    }
  }
  return null;
}

/**
 * Idempotent webhook registration:
 * 1. Check local WebhookStore for an existing active registration.
 * 2. If none, register with Jira and store the result.
 *
 * @param {string} integrationId
 * @param {string} cloudId
 * @param {string} accessToken
 * @param {string|null} jqlFilter
 * @returns {Promise<{webhookId: number, registered: boolean, registration: object}>}
 */
async function ensureWebhookRegistered(integrationId, cloudId, accessToken, jqlFilter) {
  const existing = findActiveLocalRegistration(integrationId, cloudId);
  if (existing) {
    return { webhookId: existing.webhookId, registered: false, registration: existing };
  }

  const webhookId = await registerJiraWebhook(cloudId, accessToken, jqlFilter);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + WEBHOOK_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const renewalAt = new Date(
    now.getTime() + (WEBHOOK_EXPIRY_DAYS * 24 - RENEWAL_LEAD_HOURS) * 60 * 60 * 1000
  ).toISOString();

  const registration = {
    id: uuidv4(),
    integrationId,
    cloudId,
    webhookId,
    jqlFilter: jqlFilter || null,
    events: WEBHOOK_EVENTS,
    registeredAt: now.toISOString(),
    expiresAt,
    renewalAt,
    deletedAt: null,
  };
  db.webhookRegistrations.set(registration.id, registration);

  return { webhookId, registered: true, registration };
}

/**
 * Deregister webhooks for an integration (on soft/hard delete).
 * @param {string} integrationId
 * @param {string} cloudId
 * @param {string} accessToken
 * @returns {Promise<void>}
 */
async function deregisterWebhooks(integrationId, cloudId, accessToken) {
  const toDelete = [];
  for (const reg of db.webhookRegistrations.values()) {
    if (reg.integrationId === integrationId && reg.cloudId === cloudId && !reg.deletedAt) {
      toDelete.push(reg);
    }
  }

  if (toDelete.length === 0) return;

  const webhookIds = toDelete.map((r) => r.webhookId);
  const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/webhook`;
  await axios.delete(url, {
    timeout: 15000,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    data: { webhookIds },
  });

  const now = new Date().toISOString();
  for (const reg of toDelete) {
    reg.deletedAt = now;
    db.webhookRegistrations.set(reg.id, reg);
  }
}

module.exports = {
  fetchExistingWebhooks,
  registerJiraWebhook,
  buildWebhookJqlFilter,
  findActiveLocalRegistration,
  ensureWebhookRegistered,
  deregisterWebhooks,
  WEBHOOK_EVENTS,
};
