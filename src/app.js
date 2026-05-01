'use strict';

const path = require('path');
const express = require('express');

const oauthRouter = require('./routes/oauth');
const integrationsRouter = require('./routes/integrations');
const backupRouter = require('./routes/backup');
const searchRouter = require('./routes/search');
const backupPointsRouter = require('./routes/backupPoints');
const preferencesRouter = require('./routes/preferences');
const restoreRouter = require('./routes/restore');
const sdiRouter = require('./routes/sdi');
const resilienceRouter = require('./routes/resilience');
const { assertPurgeCascadeAllowed } = require('./services/purgeCascade');

const app = express();

app.use(express.json());

// HTTP request logger — writes to stdout so podman-compose logs -f streams all traffic
app.use((req, _res, next) => {
  process.stdout.write(`${new Date().toISOString()} ${req.method} ${req.url}\n`);
  next();
});

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// API v1 routes
app.use('/api/v1/oauth', oauthRouter);
// Also mount at /oauth so the Atlassian redirect URI https://host/oauth/callback resolves.
app.use('/oauth', oauthRouter);
app.use('/api/v1/integrations', integrationsRouter);
app.use('/api/v1/integrations', backupRouter);

// Sprint 3 — Search and Object Explorer routes
app.use('/api/v1/search', searchRouter);

// Sprint 4 — Restore Engine routes
app.use('/api/v1/restore', restoreRouter);
app.use('/api/v1/backup-points', backupPointsRouter);
app.use('/api/v1/preferences', preferencesRouter);

// Sprint 5 — SDI Teaser routes
app.use('/api/v1/sdi', sdiRouter);

// Sprint 6 — Resilience Module routes
app.use('/api/v1/resilience', resilienceRouter);

// Sprint 15 — Job progress polling
app.get('/api/v1/jobs/:jobId/progress', (req, res) => {
  const { getProgress } = require('./services/jobProgress');
  const snapshot = getProgress(req.params.jobId);
  if (!snapshot) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'No progress record found for this job' });
  }
  return res.json(snapshot);
});

// Also mount at /api/ (without v1) for acceptance criteria compatibility
app.use('/api/search', searchRouter);
app.use('/api/backup-points', backupPointsRouter);
app.use('/api/preferences', preferencesRouter);
app.use('/api/sdi', sdiRouter);

// /api/connections aliases (matches acceptance criteria path style)
// POST /api/connections/:id/restore — backup-point restore (takes priority over soft-delete restore)
app.post('/api/connections/:id/restore', (req, res, next) => {
  // If body contains backupPointId, route to backup-point restore; otherwise fall through to connection restore
  if (req.body && req.body.backupPointId !== undefined) {
    const { initiateRestore } = require('./services/restoreOrchestrator');
    const { v4: uuidv4 } = require('uuid');
    const db = require('./db');
    const integrationId = req.params.id;
    const connection = db.connections.get(integrationId);
    if (!connection) {
      return res.status(404).json({ error: 'CONNECTION_NOT_FOUND', message: 'No connection found with this ID' });
    }
    const { backupPointId, conflictMode, destination } = req.body;
    if (!db.backupPoints.has(backupPointId)) {
      return res.status(404).json({ error: 'BACKUP_POINT_NOT_FOUND', message: `Backup point ${backupPointId} not found` });
    }
    if (conflictMode === 'merge') {
      return res.status(400).json({ error: 'INVALID_CONFLICT_MODE', message: 'conflictMode "merge" is permanently excluded' });
    }
    const dest = destination || { type: 'original' };
    const jobId = uuidv4();
    const now = new Date().toISOString();
    const restoreJob = { id: jobId, integrationId, type: 'restore', status: 'running', triggeredAt: now, completedAt: null, result: null, error: null };
    db.backupJobs.set(jobId, restoreJob);

    initiateRestore({
      backupPointId,
      sourceSiteId: connection.cloudId,
      destination: dest,
      conflictMode: conflictMode || 'skip',
      objectSelection: { includeAll: true },
      connectionId: integrationId,
    }).then((result) => {
      restoreJob.status = result.__validationError || result.__fieldMappingBlocked ? 'failed' : result.status;
      restoreJob.result = result;
      restoreJob.completedAt = new Date().toISOString();
      db.backupJobs.set(jobId, restoreJob);
    }).catch((err) => {
      restoreJob.status = 'failed';
      restoreJob.error = err.message;
      restoreJob.completedAt = new Date().toISOString();
      db.backupJobs.set(jobId, restoreJob);
    });

    return res.status(202).json({ jobId, status: 'running', triggeredAt: now });
  }
  next();
});
app.use('/api/connections', integrationsRouter);
app.use('/api/connections', backupRouter);


// Purge cascade endpoint (platform-layer, not scoped to a single integration)
app.post('/api/v1/purge/cascade', (req, res) => {
  const { nodeType, targetId } = req.body || {};
  if (!nodeType) {
    return res.status(400).json({ error: 'MISSING_NODE_TYPE', message: 'nodeType is required' });
  }
  try {
    assertPurgeCascadeAllowed(nodeType);
  } catch (err) {
    if (err.code === 'PURGE_CASCADE_BOUNDARY_VIOLATION') {
      return res.status(409).json({ error: err.code, message: err.message, nodeType });
    }
    throw err;
  }
  return res.status(200).json({ nodeType, targetId: targetId || null, status: 'cascade_accepted' });
});

// Frontend HTML routes
app.get('/integrations/jira/connect', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'connect.html'));
});

app.get('/integrations/jira/callback', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'callback.html'));
});

app.get('/integrations/jira/manage', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manage.html'));
});

app.get('/integrations/jira/browse', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'browse.html'));
});

app.get('/', (req, res) => {
  res.redirect('/index.html');
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` });
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
});

module.exports = app;
