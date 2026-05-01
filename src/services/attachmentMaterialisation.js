'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { PHASES, emitProgress } = require('./jobProgress');

const JIRA_API_BASE = 'https://api.atlassian.com/ex/jira';

/**
 * Download an attachment binary from Jira.
 * Returns a Buffer with the binary content.
 * @param {string} cloudId
 * @param {import('axios').AxiosInstance} jiraAxios  Shared instance with 401 interceptor
 * @param {string} attachmentId
 * @returns {Promise<Buffer>}
 */
async function downloadAttachmentBinary(cloudId, jiraAxios, attachmentId) {
  const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/attachment/content/${attachmentId}`;
  // Use a 2-minute timeout for binary downloads (large files); the shared jiraAxios
  // instance has a 30-second timeout that is intentionally overridden here.
  const response = await jiraAxios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
  return Buffer.from(response.data);
}

/**
 * Compute SHA-256 hex checksum of a Buffer.
 * @param {Buffer} buffer
 * @returns {string}
 */
function computeChecksum(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Simulate uploading a binary to object storage.
 * In production, replace with actual S3/blob storage upload.
 * Returns a storage reference string.
 * @param {string} integrationId
 * @param {string} attachmentId
 * @param {Buffer} binary
 * @returns {string}
 */
function uploadBinaryToStorage(integrationId, attachmentId, binary) {
  // In production: upload to S3/blob and return the key/URI
  return `integrations/${integrationId}/attachments/${attachmentId}`;
}

/**
 * Find the most recent manifest entry for an attachmentId from prior successful backup points
 * of this integration.
 * @param {string} integrationId
 * @param {string} attachmentId
 * @returns {object|null}
 */
function findPriorManifestEntry(integrationId, attachmentId) {
  let latest = null;
  for (const entry of db.attachmentManifestEntries.values()) {
    if (
      entry.integrationId === integrationId &&
      entry.attachmentId === attachmentId &&
      !entry.sidecarOnly
    ) {
      if (!latest || new Date(entry.downloadedAt) > new Date(latest.downloadedAt)) {
        latest = entry;
      }
    }
  }
  return latest;
}

/**
 * Process all attachments across a list of issues for a backup run.
 * - For each attachment ID not present in the prior manifest: download binary, store, create manifest entry
 * - For each attachment ID present in prior manifest: carry forward as sidecar
 * Returns the list of new manifest entries created in this run.
 *
 * @param {string} integrationId
 * @param {string} backupPointId
 * @param {object[]} issues  Array of Jira issue objects with fields.attachment
 * @param {string} cloudId
 * @param {import('axios').AxiosInstance} jiraAxios  Shared instance with 401 interceptor
 * @returns {Promise<object[]>}  New AttachmentManifestEntry records
 */
async function processAttachments(integrationId, backupPointId, issues, cloudId, jiraAxios, jobId = null) {
  const newEntries = [];
  // Track attachmentIds already processed in this run to avoid duplicates within a single run
  const processedInThisRun = new Set();

  // Count total unique attachments upfront for progress reporting
  const allAttachmentIds = new Set();
  for (const issue of issues) {
    for (const att of (issue.fields && issue.fields.attachment) || []) {
      allAttachmentIds.add(String(att.id));
    }
  }
  const totalAttachments = allAttachmentIds.size;

  for (const issue of issues) {
    const attachments = (issue.fields && issue.fields.attachment) || [];
    for (const attachment of attachments) {
      const attachmentId = String(attachment.id);

      if (processedInThisRun.has(attachmentId)) {
        continue;
      }
      processedInThisRun.add(attachmentId);

      const prior = findPriorManifestEntry(integrationId, attachmentId);

      if (prior) {
        console.debug(`[attachment] sidecar carry-forward: attachmentId=${attachmentId} issueKey=${issue.key}`);
        // Sidecar carry-forward
        const entry = {
          id: uuidv4(),
          integrationId,
          backupPointId,
          attachmentId,
          issueKey: issue.key,
          filename: attachment.filename || null,
          mimeType: attachment.mimeType || null,
          sizeBytes: attachment.size || null,
          binaryStorageRef: null,
          sidecarOnly: true,
          priorManifestEntryId: prior.id,
          downloadedAt: null,
          checksum: null,
        };
        db.attachmentManifestEntries.set(entry.id, entry);
        newEntries.push(entry);
      } else {
        // Download binary
        console.info(`[attachment] downloading binary: attachmentId=${attachmentId} issueKey=${issue.key} filename=${attachment.filename || 'unknown'}`);
        const binary = await downloadAttachmentBinary(cloudId, jiraAxios, attachmentId);
        const storageRef = uploadBinaryToStorage(integrationId, attachmentId, binary);
        const checksum = computeChecksum(binary);

        const entry = {
          id: uuidv4(),
          integrationId,
          backupPointId,
          attachmentId,
          issueKey: issue.key,
          filename: attachment.filename || null,
          mimeType: attachment.mimeType || null,
          sizeBytes: attachment.size || null,
          binaryStorageRef: storageRef,
          sidecarOnly: false,
          priorManifestEntryId: null,
          downloadedAt: new Date().toISOString(),
          checksum,
        };
        db.attachmentManifestEntries.set(entry.id, entry);
        newEntries.push(entry);
      }

      emitProgress(jobId, {
        phase: PHASES.ATTACHMENT_DOWNLOAD,
        objectType: 'JiraAttachment',
        objectKey: attachmentId,
        processed: newEntries.length,
        total: totalAttachments,
      });
    }
  }

  return newEntries;
}

/**
 * Get all manifest entries for an integration.
 * @param {string} integrationId
 * @returns {object[]}
 */
function getManifestForIntegration(integrationId) {
  const entries = [];
  for (const entry of db.attachmentManifestEntries.values()) {
    if (entry.integrationId === integrationId) {
      entries.push(entry);
    }
  }
  return entries;
}

module.exports = {
  downloadAttachmentBinary,
  computeChecksum,
  uploadBinaryToStorage,
  findPriorManifestEntry,
  processAttachments,
  getManifestForIntegration,
};
