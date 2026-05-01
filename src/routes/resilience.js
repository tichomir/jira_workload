'use strict';

/**
 * Sprint 6 — Resilience Module API Routes
 *
 * Endpoints:
 *   GET /api/v1/resilience/inventory/projects       — Paginated JiraProjectNode inventory
 *   GET /api/v1/resilience/inventory/workflows      — Paginated JiraWorkflowNode inventory
 *   GET /api/v1/resilience/inventory/custom-fields  — Paginated JiraCustomFieldNode inventory
 *   POST /api/v1/resilience/purge/cascade/basket    — Basket-level purge guard (filters excluded types)
 */

const express = require('express');
const {
  getProjectInventory,
  getWorkflowInventory,
  getCustomFieldInventory,
} = require('../services/resilienceInventoryService');
const { filterPurgeCascadeBasket } = require('../services/purgeCascade');
const { COLUMN_REGISTRY } = require('../config/resilienceRegistry');

const router = express.Router();

function parsePagination(query) {
  return {
    page: Math.max(1, parseInt(query.page, 10) || 1),
    pageSize: Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 25)),
    cloudId: query.cloudId || undefined,
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/resilience/inventory/projects
// ---------------------------------------------------------------------------

router.get('/inventory/projects', (req, res) => {
  const params = parsePagination(req.query);
  const result = getProjectInventory(params);
  return res.status(200).json({ ...result, columns: COLUMN_REGISTRY.JiraProjectNode });
});

// ---------------------------------------------------------------------------
// GET /api/v1/resilience/inventory/workflows
// ---------------------------------------------------------------------------

router.get('/inventory/workflows', (req, res) => {
  const params = parsePagination(req.query);
  const result = getWorkflowInventory(params);
  return res.status(200).json({ ...result, columns: COLUMN_REGISTRY.JiraWorkflowNode });
});

// ---------------------------------------------------------------------------
// GET /api/v1/resilience/inventory/custom-fields
// ---------------------------------------------------------------------------

router.get('/inventory/custom-fields', (req, res) => {
  const params = parsePagination(req.query);
  const result = getCustomFieldInventory(params);
  return res.status(200).json({ ...result, columns: COLUMN_REGISTRY.JiraCustomFieldNode });
});

// ---------------------------------------------------------------------------
// POST /api/v1/resilience/purge/cascade/basket
//
// Service-layer basket purge guard. Excluded node types are silently removed
// from the cascade scope; a structured exclusion log is emitted per excluded item.
// Only the allowed items are returned as cascade candidates.
// ---------------------------------------------------------------------------

router.post('/purge/cascade/basket', (req, res) => {
  const { basket } = req.body || {};
  if (!Array.isArray(basket)) {
    return res.status(400).json({
      error: 'INVALID_BASKET',
      message: 'Request body must contain a "basket" array of { nodeType, targetId } objects.',
    });
  }
  if (basket.length === 0) {
    return res.status(400).json({ error: 'EMPTY_BASKET', message: 'basket must not be empty.' });
  }

  const { allowed, excluded, exclusionLog } = filterPurgeCascadeBasket(basket);

  return res.status(200).json({
    allowed,
    excluded,
    exclusionLog,
    cascadeAccepted: allowed.length > 0,
    summary: {
      total: basket.length,
      allowedCount: allowed.length,
      excludedCount: excluded.length,
    },
  });
});

module.exports = router;
