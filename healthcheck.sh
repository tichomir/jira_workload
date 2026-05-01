#!/usr/bin/env bash
# =============================================================================
# healthcheck.sh — Confirm all jira_workload services are reachable
# =============================================================================
# Usage:
#   ./healthcheck.sh           # checks localhost:4000 (default)
#   PORT=8080 ./healthcheck.sh # override port
# =============================================================================
set -euo pipefail

PORT="${PORT:-4000}"
BASE_URL="http://localhost:${PORT}"
TIMEOUT=5
PASSED=0
FAILED=0

pass() { echo "  [PASS] $*"; PASSED=$((PASSED+1)); }
fail() { echo "  [FAIL] $*"; FAILED=$((FAILED+1)); }

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " jira_workload — Health Check"
echo " Target: ${BASE_URL}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── 1. HTTP reachability ─────────────────────────────────────────────────────
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "${TIMEOUT}" "${BASE_URL}/health" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  pass "GET /health → HTTP 200"
else
  fail "GET /health → HTTP ${HTTP_CODE} (expected 200)"
fi

# ─── 2. JSON status field ─────────────────────────────────────────────────────
BODY=$(curl -s --max-time "${TIMEOUT}" "${BASE_URL}/health" 2>/dev/null || echo "")
if echo "$BODY" | grep -q '"status"'; then
  STATUS=$(echo "$BODY" | grep -o '"status":"[^"]*"' | head -1 | sed 's/"status":"//;s/"//')
  if [ "$STATUS" = "ok" ]; then
    pass "Health response: {\"status\":\"ok\"}"
  else
    fail "Health response status field is \"${STATUS}\" (expected \"ok\")"
  fi
else
  fail "Health response is not valid JSON or missing 'status' field: ${BODY}"
fi

# ─── 3. API root reachable ────────────────────────────────────────────────────
API_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "${TIMEOUT}" "${BASE_URL}/api/v1/integrations" 2>/dev/null || echo "000")
# 200 or 401 or 404 all indicate the server is handling requests
if [ "$API_CODE" != "000" ]; then
  pass "GET /api/v1/integrations → HTTP ${API_CODE} (server responding)"
else
  fail "GET /api/v1/integrations → no response (connection refused?)"
fi

# ─── 4. Podman container status (optional — only when Podman is available) ────
if command -v podman &>/dev/null && podman info &>/dev/null 2>&1; then
  CONTAINER_STATUS=$(podman ps --filter name=jira-workload --format "{{.Status}}" 2>/dev/null | head -1 || echo "")
  if echo "$CONTAINER_STATUS" | grep -qi "up"; then
    pass "Podman container state: running"
  elif [ -z "$CONTAINER_STATUS" ]; then
    echo "  [SKIP] No jira-workload container found — skipping container state check"
  else
    fail "Podman container state: ${CONTAINER_STATUS}"
  fi
else
  echo "  [SKIP] Podman not available — skipping container state check"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Results: ${PASSED} passed, ${FAILED} failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
