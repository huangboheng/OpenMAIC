<#
start-dev.ps1 — restart both Philochora + OpenMAIC dev processes via PM2 and
reapply the new ecosystem.dev.config.cjs (which prevents the
node.exe - Application Error / 0xC0000142 dialog).

Use this instead of `pm2 startOrReload` whenever you change the ecosystem
configs, after pulling new dev infra changes, or when openmaic's status
flickers between online/errored.

Examples:
  pwsh ./scripts/start-dev.ps1
  ./scripts/start-dev.ps1          # when run from PowerShell
#>
$ErrorActionPreference = "Stop"

Set-Location -Path (Join-Path $PSScriptRoot "..")

Write-Host "==> check middleware/proxy conflict"
& node scripts/check-duplicate-roots.mjs

Write-Host "==> pm2 delete all"
pm2 delete all

Write-Host "==> pm2 start openmaic"
pm2 start "E:\hermes\workspace\openmaic\ecosystem.dev.config.cjs"

Write-Host "==> pm2 start philochora"
pm2 start "E:\hermes\workspace\Philochora\ecosystem.dev.config.cjs" --only philochora

Write-Host "==> pm2 save"
pm2 save --force

Write-Host "==> verifying"
Start-Sleep -Seconds 8
pnpm run dev:check
