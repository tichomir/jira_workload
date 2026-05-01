@echo off
REM =============================================================================
REM stop.bat — Stop jira_workload containers (Windows Command Prompt)
REM Uses Podman (rootless, daemonless) instead of Docker.
REM =============================================================================

cd /d "%~dp0"

podman info >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [jira_workload] Podman is not running - nothing to stop.
    exit /b 0
)

echo [jira_workload] Stopping containers...
podman-compose -f podman-compose.yml down
echo [jira_workload] All containers stopped.
echo.
echo Named volumes are preserved. To also remove them:
echo   podman-compose -f podman-compose.yml down -v
