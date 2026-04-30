'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const DEFAULT_REFRESH_INTERVAL_HOURS = 24;
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 168; // 7 days

/**
 * Get or create a DataScopeRefreshConfig for an integration.
 * @param {string} integrationId
 * @returns {object}
 */
function getOrCreateRefreshConfig(integrationId) {
  const existing = db.dataScopeRefreshConfigs.get(integrationId);
  if (existing) return existing;

  const now = new Date();
  const nextScheduledAt = new Date(
    now.getTime() + DEFAULT_REFRESH_INTERVAL_HOURS * 60 * 60 * 1000
  ).toISOString();

  const config = {
    id: uuidv4(),
    integrationId,
    refreshIntervalHours: DEFAULT_REFRESH_INTERVAL_HOURS,
    lastRefreshedAt: null,
    nextScheduledAt,
    manualSyncPending: false,
  };
  db.dataScopeRefreshConfigs.set(integrationId, config);
  return config;
}

/**
 * Enqueue a DataScopeRefreshJob for an integration.
 * Returns the job record.
 * @param {string} integrationId
 * @param {'scheduled'|'manual'} type
 * @param {'normal'|'high'} priority
 * @returns {object}
 */
function enqueueRefreshJob(integrationId, type, priority) {
  const job = {
    id: uuidv4(),
    integrationId,
    type,
    priority,
    status: 'queued',
    triggeredAt: new Date().toISOString(),
    completedAt: null,
  };
  db.syncJobs.set(job.id, job);
  return job;
}

/**
 * Find an in-progress refresh job for an integration.
 * @param {string} integrationId
 * @returns {object|null}
 */
function findInProgressJob(integrationId) {
  for (const job of db.syncJobs.values()) {
    if (job.integrationId === integrationId && job.status === 'in_progress') {
      return job;
    }
  }
  return null;
}

/**
 * Trigger a manual Sync Now for an integration.
 * - If a job is already in_progress, returns 202 Accepted with the existing jobId.
 * - Otherwise, enqueues a high-priority job and sets manualSyncPending=true.
 * Does NOT reset the scheduled timer.
 *
 * @param {string} integrationId
 * @returns {{ job: object, alreadyInProgress: boolean }}
 */
function triggerManualSync(integrationId) {
  // Concurrency guard
  const inProgress = findInProgressJob(integrationId);
  if (inProgress) {
    return { job: inProgress, alreadyInProgress: true };
  }

  const config = getOrCreateRefreshConfig(integrationId);
  config.manualSyncPending = true;
  db.dataScopeRefreshConfigs.set(integrationId, config);

  const job = enqueueRefreshJob(integrationId, 'manual', 'high');
  return { job, alreadyInProgress: false };
}

/**
 * Mark a sync job as completed and update the refresh config.
 * Called after the actual backup run completes.
 * @param {string} jobId
 */
function completeRefreshJob(jobId) {
  const job = db.syncJobs.get(jobId);
  if (!job) return;

  const now = new Date();
  job.status = 'completed';
  job.completedAt = now.toISOString();
  db.syncJobs.set(jobId, job);

  const config = db.dataScopeRefreshConfigs.get(job.integrationId);
  if (config) {
    config.lastRefreshedAt = now.toISOString();
    // nextScheduledAt: keep the original schedule, don't reset for manual syncs
    if (job.type === 'scheduled') {
      config.nextScheduledAt = new Date(
        now.getTime() + config.refreshIntervalHours * 60 * 60 * 1000
      ).toISOString();
    }
    config.manualSyncPending = false;
    db.dataScopeRefreshConfigs.set(job.integrationId, config);
  }
}

/**
 * The scheduler function — called every refreshIntervalHours to check which
 * integrations need a scheduled refresh and enqueue jobs for them.
 * In production, this would be invoked by a cron job.
 * @returns {object[]} jobs enqueued
 */
function runScheduler() {
  const now = new Date();
  const enqueued = [];

  for (const config of db.dataScopeRefreshConfigs.values()) {
    if (!config.nextScheduledAt) continue;
    if (new Date(config.nextScheduledAt) <= now) {
      // Only enqueue if no job is already in progress
      const inProgress = findInProgressJob(config.integrationId);
      if (!inProgress) {
        const job = enqueueRefreshJob(config.integrationId, 'scheduled', 'normal');
        enqueued.push(job);
        // Update nextScheduledAt immediately to prevent double-enqueue
        config.nextScheduledAt = new Date(
          now.getTime() + config.refreshIntervalHours * 60 * 60 * 1000
        ).toISOString();
        db.dataScopeRefreshConfigs.set(config.integrationId, config);
      }
    }
  }

  return enqueued;
}

module.exports = {
  DEFAULT_REFRESH_INTERVAL_HOURS,
  MIN_INTERVAL_HOURS,
  MAX_INTERVAL_HOURS,
  getOrCreateRefreshConfig,
  enqueueRefreshJob,
  findInProgressJob,
  triggerManualSync,
  completeRefreshJob,
  runScheduler,
};
