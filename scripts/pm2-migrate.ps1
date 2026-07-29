# pm2 migration steps captured into a single log file without piping stdout
$log = Join-Path $PSScriptRoot '..\logs\pm2-migrate.log'

function Step([string]$tag, [scriptblock]$fn) {
    Add-Content -Path $log -Value "`n=== $tag ==="
    $code = 0
    try {
        & $fn 2>&1 | ForEach-Object { Add-Content -Path $log -Value $_ }
        $code = $LASTEXITCODE
    } catch {
        Add-Content -Path $log -Value "EXC: $($_.Exception.Message)"
        $code = 1
    }
    Add-Content -Path $log -Value "EXIT=$code"
}

Set-Content -Path $log -Value "pm2-migrate @ $(Get-Date -Format 'o')"

Step 'jlist-BEFORE' { pm2 jlist }
Step 'stop'         { pm2 stop openmaic }
Step 'delete'       { pm2 delete openmaic }
Step 'jlist-AFTER-DELETE' { pm2 jlist }

Set-Location (Join-Path $PSScriptRoot '..')
Step 'start'        { pm2 start ecosystem.dev.config.cjs --only openmaic }

Step 'jlist-AFTER-START' { pm2 jlist }
Step 'show-AFTER-START'  { pm2 show openmaic }

Add-Content -Path $log -Value "`n--- done @ $(Get-Date -Format 'o') ---"
