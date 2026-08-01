<#
start-pm2-hidden.ps1 — Start PM2 (openmaic + philochora dev apps) with a
hidden node.exe supervisor so the services keep running after every PowerShell
window is closed.

Mirrors Philochora's start-philochora.ps1 approach (hidden long-lived process)
but the supervisor is node.exe (scripts/_pm2-holder.cjs), not powershell.exe:
- No powershell.exe process stays resident
- The supervisor checks the PM2 daemon every 30s and re-spawns it if dead
- Closing any visible window does not affect the service

Usage:
  pwsh ./scripts/start-pm2-hidden.ps1

Stop everything with:
  pwsh ./scripts/stop-pm2-all.ps1
#>
$ErrorActionPreference = "Stop"

$root = "E:\hermes\workspace\openmaic"
$logsDir = Join-Path $root "logs"
$pidFile = Join-Path $logsDir "pm2-hidden.pid"
$holderFile = Join-Path $root "scripts\_pm2-holder.cjs"

# Ensure logs dir exists
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

# Skip if a holder is already running (login auto-start is idempotent)
$existingPid = 0
if (Test-Path $pidFile) { $existingPid = [int]((Get-Content $pidFile -Raw).Trim()) }
if ($existingPid -gt 0 -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
    Write-Host "PM2 holder already running (PID: $existingPid)"
    exit 0
}

$process = Start-Process -FilePath "node.exe" `
    -ArgumentList @("`"$holderFile`"") `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logsDir "pm2-holder-stdout.log") `
    -RedirectStandardError (Join-Path $logsDir "pm2-holder-stderr.log") `
    -PassThru

$process.Id | Out-File -FilePath $pidFile -Encoding ASCII
Write-Host "PM2 holder started (node.exe, PID: $($process.Id))"
Write-Host "Logs: $logsDir\pm2-hidden.log"
Write-Host "To stop: pwsh ./scripts/stop-pm2-all.ps1"
