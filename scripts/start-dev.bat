@echo off
REM start-dev.bat — restart both Philochora + OpenMAIC dev processes via PM2
REM and reapply the new ecosystem.dev.config.cjs (which prevents the
REM node.exe - Application Error / 0xC0000142 dialog).
REM
REM Use this instead of `pm2 startOrReload` whenever you change the
REM ecosystem configs, after pulling new dev infra changes, or when
REM openmaic's status flickers between online/errored.
setlocal

cd /d "%~dp0\.."

echo ==^> check middleware/proxy conflict
call node scripts\check-duplicate-roots.mjs || goto :error

echo ==^> pm2 delete all
call pm2 delete all || goto :error

echo ==^> pm2 start openmaic
call pm2 start "E:\hermes\workspace\openmaic\ecosystem.dev.config.cjs" || goto :error

echo ==^> pm2 start philochora
call pm2 start "E:\hermes\workspace\Philochora\ecosystem.dev.config.cjs" --only philochora || goto :error

echo ==^> pm2 save
call pm2 save --force || goto :error

echo ==^> verifying
timeout /t 8 /nobreak >nul
call pnpm run dev:check || goto :error

echo All services are up.
exit /b 0

:error
echo.
echo start-dev FAILED. Check logs with: pm2 logs
exit /b 1
