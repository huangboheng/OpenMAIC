/**
 * lib/server/key-audit.ts
 *
 * API Key 调用审计 — 每次解析出 server-managed key 时记录。
 *
 * 设计要点：
 *   - 不落 value，只落 sha256(key).slice(0, 16)（T1 修正：8 → 16 字符）
 *   - 复用 OpenMAIC 现有 createLogger，自动经过 redact 中间件（阶段 5）
 *   - 异步落盘，不阻塞 API 响应
 *
 * 数据用途：
 *   - 阶段 6 detect-key-abuse.mjs 离线分析
 *   - 应急响应时定位泄漏 key 的使用时间窗
 */

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '@/lib/logger';

const log = createLogger('key-audit');

/**
 * 计算 fingerprint（sha256 前 16 字符 = 64 bit）
 * 比 8 字符（32 bit）安全 2^32 倍，避免哈希撞库
 */
export function fingerprint(value: string): string {
  if (!value) return '';
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export interface KeyAuditEvent {
  provider: string;
  fingerprint: string;
  callerModule: string;
  endpoint?: string;
  environment: string;
  /** 是否为 server-managed key（true）或 client-supplied key（false） */
  managed: boolean;
}

/**
 * 记录一次 key 解析事件。
 * 落盘到 logs/key-audit.log（每日轮转，保留 7 天，由部署侧 logrotate 处理）。
 */
export function recordKeyAccess(event: KeyAuditEvent): void {
  const timestamp = new Date().toISOString();
  const line = JSON.stringify({
    ts: timestamp,
    provider: event.provider,
    fp: event.fingerprint,
    caller: event.callerModule,
    endpoint: event.endpoint ?? null,
    env: event.environment,
    managed: event.managed,
  });

  // 同时落盘 + 走 logger（确保 redact 中间件也生效）
  try {
    const logDir = resolve(process.cwd(), 'logs');
    const logPath = resolve(logDir, 'key-audit.log');
    try {
      appendFileSync(logPath, line + '\n', 'utf8');
    } catch (_innerErr) {
      mkdirSync(logDir, { recursive: true });
      appendFileSync(logPath, line + '\n', 'utf8');
    }
  } catch (err) {
    log.warn(`[key-audit] 落盘失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 推断当前 environment（基于 NODE_ENV） */
export function inferEnvironment(): 'dev' | 'staging' | 'prod' {
  const env = (process.env.NODE_ENV ?? 'development').toLowerCase();
  if (env === 'production') return 'prod';
  if (env === 'staging') return 'staging';
  return 'dev';
}

/**
 * 解析并审计 server-managed key。
 * 这是 provider-config.ts 中 resolveSectionApiKey 的封装。
 */
export function resolveAndAudit(
  provider: string,
  sectionManaged: boolean,
  serverKey: string | undefined,
  clientKey: string | undefined,
  callerModule: string,
  endpoint?: string,
): string {
  let key = '';
  if (sectionManaged && serverKey) {
    key = serverKey;
    recordKeyAccess({
      provider,
      fingerprint: fingerprint(key),
      callerModule,
      endpoint,
      environment: inferEnvironment(),
      managed: true,
    });
  } else if (clientKey) {
    key = clientKey;
    recordKeyAccess({
      provider,
      fingerprint: fingerprint(key),
      callerModule,
      endpoint,
      environment: inferEnvironment(),
      managed: false,
    });
  }
  return key;
}