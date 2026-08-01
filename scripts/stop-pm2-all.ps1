<#
stop-pm2-all.ps1 — Stop the whole PM2 background system (openmaic +
philochora + philochora-admin) with the correct kill order.

Four layers of protection bring the services back if only some are killed:
1. PM2 autorestart re-spawns killed apps (2s delay)
2. pm2-io-agent watchdog re-spawns a killed daemon and restores apps
3. The node supervisor (_pm2-holder.cjs) re-spawns a killed daemon (30s)
4. Any `pm2 <cmd>` run afterwards spawns the daemon and resurrects dump.pm2

Kill order (all four must go, THEN remove dump.pm2):
  holder -> agent -> daemon -> leftover daemons -> dump.pm2

Usage:
  pwsh ./scripts/stop-pm2-all.ps1

Start again with:
  pwsh ./scripts/start-pm2-hidden.ps1
#>
$ErrorActionPreference = "Continue"

$root = "E:\hermes\workspace\openmaic"
$pm2Home = "C:\Users\Administrator\.pm2"
$holderPidFile = Join-Path $root "logs\pm2-hidden.pid"
$agentPidFile = Join-Path $pm2Home "agent.pid"
$daemonPidFile = Join-Path $pm2Home "pm2.pid"
$dumpFile = Join-Path $pm2Home "dump.pm2"

function Kill-PidFile([string]$label, [string]$pidFile, [switch]$Tree) {
    $targetPid = 0
    if (Test-Path $pidFile) { $targetPid = [int]((Get-Content $pidFile -Raw).Trim()) }
    if ($targetPid -gt 0) {
        $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
        if ($p) {
            if ($Tree) { taskkill /PID $targetPid /T /F | Out-Null } else { taskkill /PID $targetPid /F | Out-Null }
            Write-Host "$label killed (PID $targetPid)"
        } else {
            Write-Host "$label pid file points to a dead process ($targetPid), skipping"
        }
    } else {
        Write-Host "no $label pid file, nothing to kill"
    }
}

# 1) Supervisor first, so it cannot re-spawn the daemon.
Kill-PidFile "holder" $holderPidFile -Tree

# 2) pm2-io-agent watchdog next, so it cannot re-spawn the daemon.
Kill-PidFile "agent" $agentPidFile

# 3) Graceful PM2 kill if the daemon is still reachable (stops apps cleanly),
#    otherwise force-kill via the pid file.
$daemonPid = 0
if (Test-Path $daemonPidFile) { $daemonPid = [int]((Get-Content $daemonPidFile -Raw).Trim()) }
if ($daemonPid -gt 0 -and (Get-Process -Id $daemonPid -ErrorAction SilentlyContinue)) {
    & pm2 kill *> $null
    if ($?) { Write-Host "pm2 daemon killed gracefully (PID $daemonPid)" }
    else { Kill-PidFile "pm2 daemon" $daemonPidFile }
} else {
    Write-Host "no live daemon pid, skipping pm2 kill"
}

# 4) Kill ANY leftover PM2 daemon / agent processes (zombies included).
$leftovers = Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'Daemon\.js|InteractorDaemon\.js' }
foreach ($proc in $leftovers) {
    taskkill /PID $proc.ProcessId /F | Out-Null
    Write-Host "leftover killed (PID $($proc.ProcessId): $($proc.CommandLine))"
}

# 4b) Kill orphaned app containers (ProcessContainerFork whose parent daemon
# is gone) so their ports (3000/3010/3100) are actually released. Without this
# a force-killed daemon leaves apps behind that keep listening — the "can't
# stop it" symptom.
$liveDaemons = @(Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'Daemon\.js' } | Select-Object -ExpandProperty ProcessId)
$orphans = Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'ProcessContainerFork' -and $_.ParentProcessId -notin $liveDaemons }
foreach ($proc in $orphans) {
    taskkill /PID $proc.ProcessId /F | Out-Null
    Write-Host "orphan app killed (PID $($proc.ProcessId))"
}

# 5) Remove dump.pm2 so no later `pm2` command resurrects the apps.
if (Test-Path $dumpFile) {
    Remove-Item $dumpFile -Force
    Write-Host "dump.pm2 removed (no resurrection possible)"
}

# 6) Remove the holder pid file for a clean re-start.
if (Test-Path $holderPidFile) { Remove-Item $holderPidFile -Force }

# 7) Confirm.
Start-Sleep -Seconds 2
$listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in 3000, 3010, 3100 }
if ($listeners) {
    Write-Host "WARNING: still listening: $($listeners.LocalPort -join ', ') — check manually"
} else {
    Write-Host "All PM2 services stopped (ports 3000/3010/3100 free)."
}
