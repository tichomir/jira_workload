#Requires -Version 5.1
<#
.SYNOPSIS
    Start jira_workload locally on Windows (PowerShell).
.DESCRIPTION
    Uses Podman (rootless, daemonless) via WSL2. Validates that WSL2 and
    Podman are available, bootstraps .env from .env.example if absent,
    runs podman-compose up --build, and prints the local access URL.
.NOTES
    Podman must be installed inside the WSL2 Linux distribution.
    Install: wsl -- sudo apt-get install -y podman && pip install podman-compose
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

function Write-Info  { param($msg) Write-Host "[jira_workload] $msg" -ForegroundColor Green  }
function Write-Warn  { param($msg) Write-Host "[jira_workload] $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "[jira_workload] ERROR: $msg" -ForegroundColor Red }

# ─── 1. Podman / WSL2 check ──────────────────────────────────────────────────
# Prefer native podman if available (Podman Desktop for Windows installs it).
# Fall back to podman inside WSL2.
$usePodmanNative = $false
$useWsl = $false

if (Get-Command podman -ErrorAction SilentlyContinue) {
    $usePodmanNative = $true
    Write-Info "Using native Podman installation."
} elseif (Get-Command wsl -ErrorAction SilentlyContinue) {
    # Check podman is installed inside WSL2
    $wslCheck = wsl -- command -v podman 2>&1
    if ($LASTEXITCODE -eq 0 -and $wslCheck -match 'podman') {
        $useWsl = $true
        Write-Info "Using Podman inside WSL2."
    } else {
        Write-Err "Podman is not installed."
        Write-Host "  Option A (WSL2): wsl -- sudo apt-get install -y podman && pip install podman-compose"
        Write-Host "  Option B (native): install Podman Desktop from https://podman-desktop.io"
        exit 1
    }
} else {
    Write-Err "Neither native Podman nor WSL2 were found."
    Write-Host "  Install Podman Desktop from https://podman-desktop.io"
    Write-Host "  Or enable WSL2: wsl --install, then install Podman inside the distro."
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
Write-Info "Building and starting containers with Podman Compose..."
if ($useWsl) {
    wsl -- bash -c "cd $(wsl --exec wslpath -u $($ScriptDir -replace '\\','/')) && podman-compose -f podman-compose.yml up --build -d"
} else {
    podman-compose -f podman-compose.yml up --build -d
}
if ($LASTEXITCODE -ne 0) {
    Write-Err "podman-compose up failed. See output above."
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
    Write-Warn "Check logs with: podman-compose -f podman-compose.yml logs -f"
}

# ─── 6. Print access information ─────────────────────────────────────────────
Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Info "Jira Workload is running"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "  App URL:    http://localhost:${Port}"
Write-Host "  Health:     http://localhost:${Port}/health"
Write-Host "  Logs:       podman-compose -f podman-compose.yml logs -f"
Write-Host "  Stop:       .\stop.ps1"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
