#Requires -Version 5.1
<#
.SYNOPSIS
    Start jira_workload locally on Windows (PowerShell).
.DESCRIPTION
    Validates Docker Desktop is running, bootstraps .env from .env.example if
    absent, runs docker compose up --build, and prints the local access URL.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

function Write-Info  { param($msg) Write-Host "[jira_workload] $msg" -ForegroundColor Green  }
function Write-Warn  { param($msg) Write-Host "[jira_workload] $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "[jira_workload] ERROR: $msg" -ForegroundColor Red }

# ─── 1. Docker check ─────────────────────────────────────────────────────────
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Err "Docker is not installed."
    Write-Host "  Install Docker Desktop from https://www.docker.com/products/docker-desktop"
    exit 1
}

try {
    docker info 2>&1 | Out-Null
} catch {
    Write-Err "Docker Desktop is not running. Start it from the system tray and try again."
    exit 1
}

if ($LASTEXITCODE -ne 0) {
    Write-Err "Docker Desktop is not running. Start it from the system tray and try again."
    exit 1
}

# ─── 2. .env bootstrap ───────────────────────────────────────────────────────
if (-not (Test-Path .env)) {
    Write-Warn ".env not found — copying .env.example to .env"
    Copy-Item .env.example .env

    Write-Host ""
    Write-Warn "IMPORTANT: open .env and fill in your Atlassian credentials before first use:"
    Write-Warn "  * ATLASSIAN_CLIENT_ID"
    Write-Warn "  * ATLASSIAN_CLIENT_SECRET"
    Write-Warn "  * ATLASSIAN_REDIRECT_URI"
    Write-Warn "  * OAUTH_TOKEN_ENCRYPTION_KEY"
    Write-Host ""
    Write-Host "  Generate a key with PowerShell:"
    Write-Host "    -join ((1..32) | % { '{0:x2}' -f (Get-Random -Max 256) })"
    Write-Host ""
    Write-Warn "Re-run this script after editing .env."
    exit 0
}

# ─── 3. Resolve port ─────────────────────────────────────────────────────────
$Port = 4000
$portLine = Select-String -Path .env -Pattern '^PORT=' | Select-Object -First 1
if ($portLine) {
    $Port = ($portLine.Line -split '=')[1].Trim()
}

# ─── 4. Start the stack ──────────────────────────────────────────────────────
Write-Info "Building and starting containers..."
docker compose up --build -d
if ($LASTEXITCODE -ne 0) {
    Write-Err "docker compose up failed. See output above."
    exit 1
}

# ─── 5. Wait for health endpoint ─────────────────────────────────────────────
Write-Info "Waiting for the application to become healthy (up to 60 s)..."
$maxAttempts = 30
$healthy = $false
for ($i = 1; $i -le $maxAttempts; $i++) {
    Start-Sleep -Seconds 2
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:${Port}/health" `
                       -UseBasicParsing -TimeoutSec 3 -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
    Write-Host "." -NoNewline
}
Write-Host ""

if ($healthy) {
    Write-Info "Application is up!"
} else {
    Write-Warn "Health check timed out. The app may still be starting."
    Write-Warn "Check logs with: docker compose logs -f"
}

# ─── 6. Print access information ─────────────────────────────────────────────
Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Info "Jira Workload is running"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "  App URL:    http://localhost:${Port}"
Write-Host "  Health:     http://localhost:${Port}/health"
Write-Host "  Logs:       docker compose logs -f"
Write-Host "  Stop:       .\stop.ps1"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
