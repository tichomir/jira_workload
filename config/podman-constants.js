'use strict';

/**
 * podman-constants.js
 * =============================================================================
 * Deployment constants for Podman-based local and CI environments.
 *
 * jira_workload uses Podman (rootless, daemonless) in place of Docker.
 * This file documents the socket path, rootless mode flag, and
 * per-platform setup notes used by the startup/stop scripts and any
 * tooling that must interact with the container runtime directly.
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// Rootless mode
// ---------------------------------------------------------------------------
// Podman supports rootless containers natively — no root or daemon required.
// This is the recommended and default mode for jira_workload on all platforms.
const PODMAN_ROOTLESS = true;

// ---------------------------------------------------------------------------
// Podman socket paths
// ---------------------------------------------------------------------------
// The Podman socket is used by tools that speak the Docker-compatible REST API
// (e.g. podman-compose, Testcontainers, CI tooling).
//
// Linux (rootless, per-user):
//   /run/user/<UID>/podman/podman.sock
//   Resolved at runtime via: $XDG_RUNTIME_DIR/podman/podman.sock
//
// Linux (rootful, system-wide):
//   /run/podman/podman.sock
//   Requires: sudo systemctl enable --now podman.socket
//
// macOS (via podman machine):
//   ~/.local/share/containers/podman/machine/podman.sock
//   Or the path printed by: podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}'
//
// Windows (WSL2, rootless inside the distro):
//   Same as Linux rootless path inside the WSL2 filesystem.
//   Access from Windows host via the WSL2 UNC path if needed.
const PODMAN_SOCKET_PATHS = {
  /** Linux rootless (resolved at runtime using $XDG_RUNTIME_DIR) */
  linuxRootless: process.env.XDG_RUNTIME_DIR
    ? `${process.env.XDG_RUNTIME_DIR}/podman/podman.sock`
    : `/run/user/${process.getuid ? process.getuid() : 1000}/podman/podman.sock`,

  /** Linux rootful (system socket, requires root privileges) */
  linuxRootful: '/run/podman/podman.sock',

  /** macOS (podman machine; exact path varies by machine name / Podman version) */
  macos: `${process.env.HOME}/.local/share/containers/podman/machine/podman.sock`,

  /** Windows WSL2 (rootless inside WSL2 distro — same as linuxRootless) */
  windowsWsl2: process.env.XDG_RUNTIME_DIR
    ? `${process.env.XDG_RUNTIME_DIR}/podman/podman.sock`
    : `/run/user/1000/podman/podman.sock`,
};

// ---------------------------------------------------------------------------
// Docker-compatible socket alias
// ---------------------------------------------------------------------------
// Some tools (Testcontainers, older compose versions) read DOCKER_HOST to
// locate the container socket.  Point it at the Podman socket to retain
// compatibility without installing Docker.
//
// Export in your shell before running tooling:
//
//   # Linux rootless
//   export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/podman/podman.sock"
//
//   # macOS
//   export DOCKER_HOST="unix://${HOME}/.local/share/containers/podman/machine/podman.sock"
//
// The startup scripts (start.sh / start.ps1 / start.bat) set DOCKER_HOST
// automatically for the duration of the compose run.
const DOCKER_HOST_TEMPLATE = {
  linuxRootless: `unix://${PODMAN_SOCKET_PATHS.linuxRootless}`,
  macos:         `unix://${PODMAN_SOCKET_PATHS.macos}`,
  windowsWsl2:   `unix://${PODMAN_SOCKET_PATHS.windowsWsl2}`,
};

// ---------------------------------------------------------------------------
// Per-platform setup notes
// ---------------------------------------------------------------------------
const PLATFORM_NOTES = {
  /**
   * macOS
   * ─────
   * Podman on macOS runs containers inside a lightweight Linux VM managed by
   * `podman machine`.  You must initialise and start the machine once before
   * using podman-compose.
   *
   *   brew install podman podman-compose   # or: pip install podman-compose
   *   podman machine init
   *   podman machine start
   *
   * The machine exposes a rootless socket at the path in PODMAN_SOCKET_PATHS.macos.
   * No Docker Desktop or daemon is required.
   */
  macos: 'podman machine init && podman machine start  (run once; brew install podman podman-compose)',

  /**
   * Linux
   * ─────
   * Rootless Podman works natively without a daemon.  Install via your distro
   * package manager, then use podman-compose directly.
   *
   *   # Fedora / RHEL / CentOS Stream:
   *   sudo dnf install -y podman podman-compose
   *
   *   # Debian / Ubuntu:
   *   sudo apt-get install -y podman
   *   pip install podman-compose        # or: pipx install podman-compose
   *
   * To activate the user socket (needed by DOCKER_HOST compatibility):
   *   systemctl --user enable --now podman.socket
   */
  linux: 'sudo dnf install podman podman-compose  (Fedora/RHEL)  or  sudo apt install podman + pip install podman-compose  (Debian/Ubuntu)',

  /**
   * Windows — WSL2
   * ──────────────
   * Install Podman inside the WSL2 Linux distribution (e.g. Ubuntu).
   * All podman / podman-compose commands must be run from the WSL2 terminal.
   * The Windows-native Podman Desktop GUI is optional.
   *
   *   # Inside WSL2 Ubuntu:
   *   sudo apt-get update && sudo apt-get install -y podman
   *   pip install podman-compose
   *   systemctl --user enable --now podman.socket
   *
   * Then run ./start.sh from the WSL2 terminal.
   * Windows native start.bat / start.ps1 delegate to WSL2 automatically
   * if the wsl binary is on the PATH.
   */
  windowsWsl2: 'Run from WSL2 terminal: sudo apt install podman && pip install podman-compose && systemctl --user enable --now podman.socket',
};

// ---------------------------------------------------------------------------
// Compose file name
// ---------------------------------------------------------------------------
// Use podman-compose.yml as the default compose manifest.
// Pass -f podman-compose.yml explicitly if tooling defaults to docker-compose.yml.
const COMPOSE_FILE = 'podman-compose.yml';

// ---------------------------------------------------------------------------
// Minimum version requirements
// ---------------------------------------------------------------------------
const MIN_VERSIONS = {
  podman:        '4.0.0',
  podmanCompose: '1.0.0',
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  PODMAN_ROOTLESS,
  PODMAN_SOCKET_PATHS,
  DOCKER_HOST_TEMPLATE,
  PLATFORM_NOTES,
  COMPOSE_FILE,
  MIN_VERSIONS,
};
