// scripts/lib/db-url.mjs
// 统一数据库连接串解析：process.env.DATABASE_URL > 项目根 .env.local > 内置默认。
// 解决部署端（VPS 5432/philochora）与本地开发（5999/postgres）配置漂移问题：
// 两端各自维护 .env.local，脚本无需改默认值即可正确连接。
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function getDatabaseUrl(fallback) {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const env = readFileSync(join(PROJECT_ROOT, '.env.local'), 'utf8');
    const m = env.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    // .env.local 不存在时静默降级到内置默认
  }
  return fallback;
}
