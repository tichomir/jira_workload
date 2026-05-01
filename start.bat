@echo off
REM =============================================================================
REM start.bat — Start jira_workload locally (Windows Command Prompt)
REM =============================================================================
REM  Prefer start.ps1 (PowerShell) for richer output.  This .bat is provided as
REM  a fallback for environments where PowerShell execution is restricted.
REM =============================================================================

cd /d "%~dp0"

REM ─── 1. Docker check ─────────────────────────────────────────────────────
docker info >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [jira_workload] ERROR: Docker Desktop is not running.
    echo   Start Docker Desktop from the system tray and try again.
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
echo [jira_workload] Building and starting containers...
docker compose up --build -d
if %ERRORLEVEL% neq 0 (
    echo [jira_workload] ERROR: docker compose up failed.
    exit /b 1
)

REM ─── 4. Print access information ─────────────────────────────────────────
echo.
echo ================================================
echo  Jira Workload is running
echo ================================================
echo   App URL:  http://localhost:4000
echo   Health:   http://localhost:4000/health
echo   Logs:     docker compose logs -f
echo   Stop:     stop.bat
echo ================================================
echo.
echo Tip: use start.ps1 (PowerShell) for live health-check feedback.
