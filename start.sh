#!/usr/bin/env bash
# =============================================================================
# start.sh — Start jira_workload locally (macOS / Linux)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ─── Colour helpers ───────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
info()  { echo -e "${GREEN}[jira_workload]${NC} $*"; }
warn()  { echo -e "${YELLOW}[jira_workload]${NC} $*"; }
error() { echo -e "${RED}[jira_workload] ERROR:${NC} $*" >&2; }

# ─── 1. Docker check ─────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  error "Docker is not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop"
  exit 1
fi

if ! docker info &>/dev/null; then
  error "Docker daemon is not running."
  echo "  • macOS / Windows: Start Docker Desktop."
  echo "  • Linux: sudo systemctl start docker"
  exit 1
fi

# ─── 2. .env bootstrap ───────────────────────────────────────────────────────
if [ ! -f .env ]; then
  warn ".env not found — copying .env.example to .env"
  cp .env.example .env
  echo ""
  warn "IMPORTANT: open .env and fill in your Atlassian credentials before first use:"
  warn "  • ATLASSIAN_CLIENT_ID"
  warn "  • ATLASSIAN_CLIENT_SECRET"
  warn "  • ATLASSIAN_REDIRECT_URI"
  warn "  • OAUTH_TOKEN_ENCRYPTION_KEY  (generate: openssl rand -hex 32)"
  echo ""
  warn "Re-run this script after editing .env."
  exit 0
fi

# ─── 3. Resolve port from .env (fallback 4000) ───────────────────────────────
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]' || true)
PORT="${PORT:-4000}"

# ─── 4. Bring the stack up ───────────────────────────────────────────────────
info "Building and starting containers..."
docker compose up --build -d

# ─── 5. Wait for healthy status ──────────────────────────────────────────────
info "Waiting for the application to become healthy (up to 60 s)..."
MAX=30
for i in $(seq 1 $MAX); do
  STATUS=$(docker compose ps --format json 2>/dev/null \
    | grep -o '"Health":"[^"]*"' | head -1 \
    | sed 's/"Health":"//;s/"//' || true)

  # Fallback: try the health endpoint directly
  if curl -sf "http://localhost:${PORT}/health" &>/dev/null; then
    echo ""
    info "Application is up!"
    break
  fi

  if [ "$i" -eq "$MAX" ]; then
    echo ""
    warn "Health check timed out. The application may still be starting."
    warn "Check logs with: docker compose logs -f"
  else
    printf '.'
    sleep 2
  fi
done

# ─── 6. Print access information ─────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
info "Jira Workload is running"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  App URL:    http://localhost:${PORT}"
echo "  Health:     http://localhost:${PORT}/health"
echo "  Logs:       docker compose logs -f"
echo "  Stop:       ./stop.sh"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
