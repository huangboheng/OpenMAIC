/**
 * PM2 development configuration for OpenMAIC.
 *
 * Usage (from the project root):
 *   pm2 startOrReload ecosystem.dev.config.cjs --only openmaic
 *   pm2 stop     openmaic
 *   pm2 restart  openmaic --update-env
 *   pm2 logs     openmaic
 *
 * Notes:
 * - Logs are written under ./logs/ (relative to this file's directory) so that
 *   they stay with the project instead of leaking into sibling directories.
 * - `cwd` is pinned to the directory containing this file so the process runs
 *   regardless of where `pm2 start` was invoked from.
 */
const path = require('path');

const root = __dirname;
const logsDir = path.join(root, 'logs');

module.exports = {
  apps: [
    {
      name: 'openmaic',
      cwd: root,
      script: path.join('node_modules', 'next', 'dist', 'bin', 'next'),
      args: 'dev -p 3010',
      interpreter: 'node',
      // Use `node` to run the next bin script directly so the working
      // directory path resolution below matches what `pnpm dev` would do.
      // Cap V8 old-space to 1 GB so the engine GCs aggressively instead of
      // hitting a FatalOOM when system memory is tight (see 2026-07-29 crash).
      node_args: ['--max-old-space-size=1024'],
      env: {
        NODE_ENV: 'development',
      },
      // Auto-restart after crashes (e.g. V8 FatalOOM) so the service
      // recovers without manual intervention. max_restarts guards against
      // infinite restart loops on persistent failures.
      autorestart: true,
      max_restarts: 5,
      restart_delay: 2000,
      out_file: path.join(logsDir, 'pm2-openmaic-out.log'),
      error_file: path.join(logsDir, 'pm2-openmaic-err.log'),
      merge_logs: true,
      time: true,
      // Lowered from 1G to 512M: the 2026-07-29 crash showed that V8
      // FatalOOM can strike before RSS reaches 1G when system memory is
      // scarce. 512M lets PM2 restart the process earlier, reducing the
      // window where a runaway heap starves the OS.
      max_memory_restart: '512M',
    },
  ],
};
