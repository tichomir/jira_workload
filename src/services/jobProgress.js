'use strict';

/**
 * jobProgress.js — Granular job progress tracking for backup and restore jobs.
 *
 * Provides:
 *   - PHASES enum matching the JobProgressEvent.phase field
 *   - emitProgress(jobId, snapshot)        — upsert latest progress for a job
 *   - incrementApiCallCount(jobId)         — called from Axios request interceptor
 *   - getProgress(jobId)                   — return current progress snapshot
 */

const db = require('../db');

// ---------------------------------------------------------------------------
// Phase enum
// ---------------------------------------------------------------------------

const PHASES = {
  INIT: 'INIT',
  PROJECT_DISCOVERY: 'PROJECT_DISCOVERY',
  ISSUE_FETCH: 'ISSUE_FETCH',
  ATTACHMENT_DOWNLOAD: 'ATTACHMENT_DOWNLOAD',
  WORKFLOW_ENUM: 'WORKFLOW_ENUM',
  CUSTOM_FIELD_ENUM: 'CUSTOM_FIELD_ENUM',
  MANIFEST_WRITE: 'MANIFEST_WRITE',
  FINALIZING: 'FINALIZING',
};

// ---------------------------------------------------------------------------
// emitProgress
// ---------------------------------------------------------------------------

/**
 * Upsert the latest progress snapshot for a job.
 * Merges into the existing record so callers can update individual fields.
 *
 * @param {string} jobId
 * @param {object} snapshot  Partial JobProgressEvent fields to apply
 */
function emitProgress(jobId, snapshot) {
  if (!jobId) return;
  const existing = db.jobProgress.get(jobId) || {
    jobId,
    phase: PHASES.INIT,
    objectType: null,
    objectKey: null,
    processed: 0,
    total: 0,
    apiCallCount: 0,
    errorCount: 0,
    timestampMs: Date.now(),
  };
  const updated = {
    ...existing,
    ...snapshot,
    jobId,
    timestampMs: Date.now(),
  };
  db.jobProgress.set(jobId, updated);
}

// ---------------------------------------------------------------------------
// incrementApiCallCount
// ---------------------------------------------------------------------------

/**
 * Increment the outbound Atlassian API call counter for a job.
 * Called from the Axios request interceptor on createJiraAxiosInstance.
 *
 * @param {string} jobId
 */
function incrementApiCallCount(jobId) {
  if (!jobId) return;
  const progress = db.jobProgress.get(jobId);
  if (!progress) return;
  progress.apiCallCount = (progress.apiCallCount || 0) + 1;
  progress.timestampMs = Date.now();
  db.jobProgress.set(jobId, progress);
}

// ---------------------------------------------------------------------------
// getProgress
// ---------------------------------------------------------------------------

/**
 * Return the current progress snapshot for a job, or null if not found.
 *
 * @param {string} jobId
 * @returns {object|null}
 */
function getProgress(jobId) {
  return db.jobProgress.get(jobId) || null;
}

module.exports = { PHASES, emitProgress, incrementApiCallCount, getProgress };
