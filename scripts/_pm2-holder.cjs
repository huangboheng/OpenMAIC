/**
 * _pm2-holder.cjs — long-lived node supervisor for the PM2 daemon.
 *
 * Started hidden via scripts/start-pm2-hidden.ps1 (Start-Process node.exe
 * -WindowStyle Hidden). Every 30s it checks that the PM2 daemon
 * (C:\Users\Administrator\.pm2\pm2.pid) is still alive and re-spawns it via
 * `pm2 start <service-ecosystem.config.cjs>` otherwise.
 *
 * Using node.exe (not powershell.exe) keeps the process list clean — only
 * node processes (daemon / holder / apps) are ever resident.
 *
 * Stop everything with scripts/stop-pm2-all.ps1 (kill holder first, then
 * daemon; reverse order lets the supervisor bring the daemon back).
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');

const PM2_PID_FILE = 'C:\\Users\\Administrator\\.pm2\\pm2.pid';
const CONFIG_FILE = 'E:/hermes/workspace/openmaic/scripts/service-ecosystem.config.cjs';
const LOG_FILE = 'E:/hermes/workspace/openmaic/logs/pm2-hidden.log';

function daemonAlive() {
  let pid = 0;
  try {
    pid = parseInt(fs.readFileSync(PM2_PID_FILE, 'utf8').trim(), 10);
  } catch (e) {
    return false; // pid file missing/unreadable
  }
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch (e) {
    // EPERM means the process exists but is owned by another user
    return e && e.code === 'EPERM';
  }
}

function log(line) {
  const msg = '[' + new Date().toISOString() + '] ' + line;
  console.log(msg); // always mirror to stdout (captured by start-pm2-hidden.ps1)
  try {
    fs.appendFileSync(LOG_FILE, msg + '\n');
  } catch (e) {
    // Never crash the supervisor over logging, but make failures visible via
    // stderr (captured by start-pm2-hidden.ps1 -> pm2-holder-stderr.log).
    console.error('[holder] log write failed: ' + (e.message || e));
  }
}

// Startup marker — proves the module-level code actually ran.
console.log('[holder] supervisor started, pid=' + process.pid + ', pm2.pid=' + (function () { try { return fs.readFileSync(PM2_PID_FILE, 'utf8').trim(); } catch (e) { return '(missing)'; } })());

function startPm2() {
  log('startPm2: executing pm2 start "' + CONFIG_FILE + '"');
  try {
    // execFileSync with an argv array (no shell string interpolation).
    // Windows cannot exec .cmd directly (EINVAL), so run it via cmd.exe /c
    // with argument vector — safe, no shell metacharacter parsing of CONFIG.
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', 'pm2', 'start', CONFIG_FILE], {
      encoding: 'utf8',
      windowsHide: true,
    });
    log('startPm2: success\n' + out);
  } catch (e) {
    log('startPm2: FAILED - ' + (e.message || e));
  }
}

if (!daemonAlive()) {
  log('daemon not alive at startup, spawning');
  startPm2();
} else {
  log('daemon already alive at startup, skipping');
}

setInterval(function () {
  if (!daemonAlive()) {
    log('daemon not alive, re-spawning');
    startPm2();
  }
}, 15000);
