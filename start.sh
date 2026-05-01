#!/usr/bin/env bash
# =============================================================================
# start.sh — Start jira_workload locally (macOS / Linux)
# Uses Podman (rootless, daemonless) instead of Docker.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ─── Colour helpers ───────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
info()  { echo -e "${GREEN}[jira_workload]${NC} $*"; }
warn()  { echo -e "${YELLOW}[jira_workload]${NC} $*"; }
error() { echo -e "${RED}[jira_workload] ERROR:${NC} $*" >&2; }

# ─── 1. Podman check ─────────────────────────────────────────────────────────
if ! command -v podman &>/dev/null; then
  error "Podman is not installed."
  echo "  • macOS:           brew install podman && podman machine init && podman machine start"
  echo "  • Fedora/RHEL:     sudo dnf install -y podman podman-compose"
  echo "  • Debian/Ubuntu:   sudo apt-get install -y podman && pip install podman-compose"
  echo "  • Windows (WSL2):  run from a WSL2 terminal after installing podman inside the distro"
  exit 1
fi

if ! command -v podman-compose &>/dev/null; then
  error "podman-compose is not installed."
  echo "  Install with: pip install podman-compose   (or: pipx install podman-compose)"
  exit 1
fi

# macOS: ensure the podman machine is running
if [[ "$(uname -s)" == "Darwin" ]]; then
  if ! podman machine inspect &>/dev/null 2>&1; then
    error "No Podman machine found. Initialise and start one first:"
    echo "  podman machine init && podman machine start"
    exit 1
  fi
  MACHINE_STATE=$(podman machine inspect --format '{{.State}}' 2>/dev/null || true)
  if [[ "$MACHINE_STATE" != "running" ]]; then
    warn "Podman machine is not running. Starting it..."
    podman machine start
  fi
fi

# Linux: export rootless socket so podman-compose can find it
if [[ "$(uname -s)" == "Linux" ]]; then
  XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/podman/podman.sock"
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
info "Building and starting containers with Podman Compose..."
podman-compose -f podman-compose.yml up --build -d

# ─── 5. Wait for healthy status ──────────────────────────────────────────────
info "Waiting for the application to become healthy (up to 60 s)..."
MAX=30
for i in $(seq 1 $MAX); do
  # Try the health endpoint directly
  if curl -sf "http://localhost:${PORT}/health" &>/dev/null; then
    echo ""
    info "Application is up!"
    break
  fi

  if [ "$i" -eq "$MAX" ]; then
    echo ""
    warn "Health check timed out. The application may still be starting."
    warn "Check logs with: podman-compose -f podman-compose.yml logs -f"
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
echo "  Logs:       podman-compose -f podman-compose.yml logs -f"
echo "  Stop:       ./stop.sh"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
