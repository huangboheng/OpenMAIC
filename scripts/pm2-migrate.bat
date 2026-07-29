@echo off
setlocal
cd /d "%~dp0\.."
echo --- pm2 migrate start ---
echo --- pm2 list BEFORE ---
pm2 jlist > logs\pm2-migrate.log 2>&1
echo STOP: %errorlevel% >> logs\pm2-migrate.log
pm2 stop openmaic >> logs\pm2-migrate.log 2>&1
echo DELETE: %errorlevel% >> logs\pm2-migrate.log
pm2 delete openmaic >> logs\pm2-migrate.log 2>&1
echo JLIST-AFTER: %errorlevel% >> logs\pm2-migrate.log
pm2 jlist >> logs\pm2-migrate.log 2>&1
echo START: %errorlevel% >> logs\pm2-migrate.log
pm2 start ecosystem.dev.config.cjs --only openmaic >> logs\pm2-migrate.log 2>&1
echo JLIST-FINAL: %errorlevel% >> logs\pm2-migrate.log
pm2 jlist >> logs\pm2-migrate.log 2>&1
echo --- pm2 migrate done ---
exit /b 0
