#!/usr/bin/env bash
# =============================================================================
# stop.sh — Stop and clean up jira_workload containers (macOS / Linux)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GREEN}[jira_workload]${NC} $*"; }
warn() { echo -e "${YELLOW}[jira_workload]${NC} $*"; }

if ! docker info &>/dev/null; then
  warn "Docker daemon is not running — nothing to stop."
  exit 0
fi

info "Stopping containers..."
docker compose down

info "All containers stopped."
echo ""
echo "Named volumes (backup_data, sdi_tmp, export_data) are preserved."
echo "To remove volumes too: docker compose down -v"
