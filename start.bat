@echo off
REM =============================================================================
REM start.bat — Start jira_workload locally (Windows Command Prompt)
REM Uses Podman (rootless, daemonless) instead of Docker.
REM =============================================================================
REM  Prefer start.ps1 (PowerShell) for richer output and WSL2 auto-detection.
REM  This .bat is provided as a fallback for environments where PowerShell
REM  execution policy is restricted.
REM
REM  Podman must be installed and available on PATH, or accessible via WSL2.
REM  Install: https://podman-desktop.io  or run from WSL2 terminal.
REM =============================================================================

cd /d "%~dp0"

REM ─── 1. Podman check ─────────────────────────────────────────────────────
podman info >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [jira_workload] ERROR: Podman is not running or not installed.
    echo   Install Podman Desktop from https://podman-desktop.io
    echo   Or run this script from a WSL2 terminal with Podman installed.
    exit /b 1
)

REM ─── 2. .env bootstrap ───────────────────────────────────────────────────
if not exist .env (
    echo [jira_workload] .env not found. Copying .env.example to .env...
    copy .env.example .env >nul
    echo.
    echo [jira_workload] IMPORTANT: Open .env and fill in your Atlassian credentials:
    echo   * ATLASSIAN_CLIENT_ID
    echo   * ATLASSIAN_CLIENT_SECRET
    echo   * ATLASSIAN_REDIRECT_URI
    echo   * OAUTH_TOKEN_ENCRYPTION_KEY
    echo.
    echo   Generate a key (Node.js):
    echo     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    echo.
    echo [jira_workload] Re-run this script after editing .env.
    exit /b 0
)

REM ─── 3. Start the stack ──────────────────────────────────────────────────
echo [jira_workload] Building and starting containers with Podman Compose...
podman-compose -f podman-compose.yml up --build -d
if %ERRORLEVEL% neq 0 (
    echo [jira_workload] ERROR: podman-compose up failed.
    exit /b 1
)

REM ─── 4. Print access information ─────────────────────────────────────────
echo.
echo ================================================
echo  Jira Workload is running
echo ================================================
echo   App URL:  http://localhost:4000
echo   Health:   http://localhost:4000/health
echo   Logs:     podman-compose -f podman-compose.yml logs -f
echo   Stop:     stop.bat
echo ================================================
echo.
echo Tip: use start.ps1 (PowerShell) for live health-check feedback.
