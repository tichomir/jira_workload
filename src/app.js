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
const { assertPurgeCascadeAllowed } = require('./services/purgeCascade');

const app = express();

app.use(express.json());

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// API v1 routes
app.use('/api/v1/oauth', oauthRouter);
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

// Also mount at /api/ (without v1) for acceptance criteria compatibility
app.use('/api/search', searchRouter);
app.use('/api/backup-points', backupPointsRouter);
app.use('/api/preferences', preferencesRouter);
app.use('/api/sdi', sdiRouter);

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
  res.redirect('/integrations/jira/connect');
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
