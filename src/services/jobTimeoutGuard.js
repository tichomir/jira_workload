'use strict';

/**
 * jobTimeoutGuard.js — Dead-job recovery via heartbeat timeout.
 *
 * Any backup or restore job that stops emitting heartbeats for longer than
 * JOB_TIMEOUT_MINUTES is force-failed with failureReason 'JOB_TIMEOUT'.
 *
 * Design:
 *   - The running job emits a heartbeat (updates lastHeartbeatAt) every
 *     HEARTBEAT_INTERVAL_MS while it is alive.
 *   - This guard runs every GUARD_CHECK_INTERVAL_MS and kills any job whose
 *     lastHeartbeatAt (or triggeredAt for legacy jobs without heartbeats) is
 *     older than JOB_TIMEOUT_MINUTES.
 *   - A WARN log is emitted for every force-terminated job.
 */

const db = require('../db');
const { JOB_TIMEOUT_MINUTES } = require('../config/env');

const GUARD_CHECK_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes
const HEARTBEAT_INTERVAL_MS   = 60 * 1000;       // 60 seconds

/**
 * Check all running jobs and force-fail any that have exceeded the timeout.
 * Called on startup and then every GUARD_CHECK_INTERVAL_MS.
 */
function checkTimeouts() {
  const now = Date.now();
  const timeoutMs = JOB_TIMEOUT_MINUTES * 60 * 1000;

  for (const [jobId, job] of db.backupJobs.entries()) {
    if (job.status !== 'running') continue;

    // Prefer lastHeartbeatAt; fall back to triggeredAt for jobs created before
    // heartbeat support was added (e.g. a job that was running before upgrade).
    const lastAliveTs = job.lastHeartbeatAt || job.triggeredAt;
    if (!lastAliveTs) continue;

    const ageMs = now - new Date(lastAliveTs).getTime();
    if (ageMs > timeoutMs) {
      console.warn(
        `[jobTimeoutGuard] WARN: force-terminating stuck job` +
        ` jobId=${jobId}` +
        ` integrationId=${job.integrationId}` +
        ` lastHeartbeatAt=${job.lastHeartbeatAt || '(none)'}` +
        ` triggeredAt=${job.triggeredAt}` +
        ` ageMinutes=${Math.round(ageMs / 60000)}` +
        ` timeoutMinutes=${JOB_TIMEOUT_MINUTES}`
      );
      job.status = 'failed';
      job.failureReason = 'JOB_TIMEOUT';
      job.error = `Job exceeded timeout of ${JOB_TIMEOUT_MINUTES} minutes without a heartbeat`;
      job.completedAt = new Date().toISOString();
      db.backupJobs.set(jobId, job);
    }
  }
}

/**
 * Create a heartbeat emitter for a running job.
 * Returns a stop function — call it when the job finishes (success or error).
 *
 * Usage:
 *   const stopHeartbeat = startHeartbeat(jobId);
 *   try { await doWork(); } finally { stopHeartbeat(); }
 *
 * @param {string} jobId
 * @returns {() => void}  stop function
 */
function startHeartbeat(jobId) {
  const timer = setInterval(() => {
    const job = db.backupJobs.get(jobId);
    if (job && job.status === 'running') {
      job.lastHeartbeatAt = new Date().toISOString();
      db.backupJobs.set(jobId, job);
    } else {
      // Job is no longer running — clean up the timer automatically.
      clearInterval(timer);
    }
  }, HEARTBEAT_INTERVAL_MS);

  if (timer.unref) timer.unref(); // don't block process exit

  return function stopHeartbeat() {
    clearInterval(timer);
  };
}

/**
 * Start the periodic timeout-check loop and run an initial check immediately.
 * Should be called once at application startup.
 */
function startGuard() {
  // Run once immediately on startup to recover any jobs that were left running
  // from a previous server instance that crashed without cleaning up.
  checkTimeouts();

  const timer = setInterval(checkTimeouts, GUARD_CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref(); // don't block process exit

  console.info(
    `[jobTimeoutGuard] Started — check interval: ${GUARD_CHECK_INTERVAL_MS / 1000}s,` +
    ` timeout: ${JOB_TIMEOUT_MINUTES} minutes`
  );
}

module.exports = { startGuard, startHeartbeat, checkTimeouts };
