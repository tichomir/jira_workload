#Requires -Version 5.1
<#
.SYNOPSIS
    Stop jira_workload containers (Windows PowerShell).
.DESCRIPTION
    Runs docker compose down to stop and remove containers.
    Named volumes are preserved by default (pass -RemoveVolumes to also delete them).
.PARAMETER RemoveVolumes
    Also remove named Docker volumes (backup_data, sdi_tmp, export_data).
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

try { docker info 2>&1 | Out-Null } catch { }
if ($LASTEXITCODE -ne 0) {
    Write-Warn "Docker Desktop is not running — nothing to stop."
    exit 0
}

Write-Info "Stopping containers..."
if ($RemoveVolumes) {
    docker compose down -v
    Write-Info "Containers and volumes removed."
} else {
    docker compose down
    Write-Info "All containers stopped."
    Write-Host ""
    Write-Host "Named volumes (backup_data, sdi_tmp, export_data) are preserved."
    Write-Host "To remove volumes too: docker compose down -v  (or .\stop.ps1 -RemoveVolumes)"
}
