'use strict';

const path = require('path');
const express = require('express');

const oauthRouter = require('./routes/oauth');
const integrationsRouter = require('./routes/integrations');

const app = express();

app.use(express.json());

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// API v1 routes
app.use('/api/v1/oauth', oauthRouter);
app.use('/api/v1/integrations', integrationsRouter);

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
