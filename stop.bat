@echo off
REM =============================================================================
REM stop.bat — Stop jira_workload containers (Windows Command Prompt)
REM =============================================================================

cd /d "%~dp0"

docker info >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [jira_workload] Docker Desktop is not running - nothing to stop.
    exit /b 0
)

echo [jira_workload] Stopping containers...
docker compose down
echo [jira_workload] All containers stopped.
echo.
echo Named volumes are preserved. To also remove them:
echo   docker compose down -v
