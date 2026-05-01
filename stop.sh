#!/usr/bin/env bash
# =============================================================================
# stop.sh — Stop and clean up jira_workload containers (macOS / Linux)
# Uses Podman (rootless, daemonless) instead of Docker.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GREEN}[jira_workload]${NC} $*"; }
warn() { echo -e "${YELLOW}[jira_workload]${NC} $*"; }

if ! command -v podman-compose &>/dev/null; then
  warn "podman-compose is not installed — nothing to stop."
  exit 0
fi

# Linux: export rootless socket so podman-compose can find it
if [[ "$(uname -s)" == "Linux" ]]; then
  XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/podman/podman.sock"
fi

info "Stopping containers..."
podman-compose -f podman-compose.yml down

info "All containers stopped."
echo ""
echo "Named volumes (backup_data, sdi_tmp, export_data) are preserved."
echo "To remove volumes too: podman-compose -f podman-compose.yml down -v"
