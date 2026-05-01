#Requires -Version 5.1
<#
.SYNOPSIS
    Stop jira_workload containers (Windows PowerShell).
.DESCRIPTION
    Runs podman-compose down to stop and remove containers.
    Named volumes are preserved by default (pass -RemoveVolumes to also delete them).
    Uses Podman (rootless, daemonless) via native install or WSL2.
.PARAMETER RemoveVolumes
    Also remove named Podman volumes (backup_data, sdi_tmp, export_data).
#>
param(
    [switch]$RemoveVolumes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

function Write-Info { param($msg) Write-Host "[jira_workload] $msg" -ForegroundColor Green  }
function Write-Warn { param($msg) Write-Host "[jira_workload] $msg" -ForegroundColor Yellow }

# Detect whether to use native podman or WSL2
$useWsl = $false
if (-not (Get-Command podman-compose -ErrorAction SilentlyContinue)) {
    if (Get-Command wsl -ErrorAction SilentlyContinue) {
        $useWsl = $true
    } else {
        Write-Warn "podman-compose is not installed — nothing to stop."
        exit 0
    }
}

Write-Info "Stopping containers..."
$downArgs = if ($RemoveVolumes) { "down -v" } else { "down" }
if ($useWsl) {
    wsl -- bash -c "cd $(wsl --exec wslpath -u $($ScriptDir -replace '\\','/')) && podman-compose -f podman-compose.yml $downArgs"
} else {
    Invoke-Expression "podman-compose -f podman-compose.yml $downArgs"
}

if ($RemoveVolumes) {
    Write-Info "Containers and volumes removed."
} else {
    Write-Info "All containers stopped."
    Write-Host ""
    Write-Host "Named volumes (backup_data, sdi_tmp, export_data) are preserved."
    Write-Host "To remove volumes too: podman-compose -f podman-compose.yml down -v  (or .\stop.ps1 -RemoveVolumes)"
}
