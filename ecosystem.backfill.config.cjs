/**
 * ecosystem.backfill.config.cjs
 *
 * TTS 补生成脚本 PM2 托管配置（独立于 Qoder 生命周期，关闭 IDE 不影响运行）。
 *
 * 用法：
 *   npx pm2 start ecosystem.backfill.config.cjs
 *   npx pm2 logs backfill-tts
 *   npx pm2 stop backfill-tts
 *
 * 行为：
 *   - 崩溃退出（非 0）→ 30s 后自动重启
 *   - 正常完成（exit 0，全部补完）→ 不重启，进程处于 stopped
 */
module.exports = {
  apps: [
    {
      name: 'backfill-tts',
      script: './scripts/backfill-missing-tts.mjs',
      args: '--priority',
      cwd: __dirname,
      interpreter: 'node',
      autorestart: true,
      restart_delay: 30_000,
      max_restarts: 100,
      stop_exit_codes: [0],
      out_file: './logs/backfill-pm2-out.log',
      error_file: './logs/backfill-pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
