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
      node_args: [],
      env: {
        NODE_ENV: 'development',
      },
      // Restart loop in dev is undesirable; pm2 default is true which can
      // thrash on transient Turbopack compile failures. Let it exit and
      // surface the error instead.
      autorestart: false,
      restart_delay: 1000,
      out_file: path.join(logsDir, 'pm2-openmaic-out.log'),
      error_file: path.join(logsDir, 'pm2-openmaic-err.log'),
      merge_logs: true,
      time: true,
      // Keep logs reasonable in dev so accidental long-running sessions do
      // not eat the disk. 1G matches Philochora and avoids accumulating
      // node.exe processes that together can trigger STATUS_DLL_INIT_FAILED
      // (0xC0000142) dialogs on Windows.
      max_memory_restart: '1G',
    },
  ],
};
