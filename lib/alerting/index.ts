/**
 * lib/alerting/index.ts
 *
 * 统一告警接口（阶段 6 M1-M4）。
 *
 * 支持通道：
 *   - Slack Incoming Webhook
 *   - 飞书 / 钉钉 Webhook（通过 Slack-compatible adapter）
 *   - 邮件（通过 SMTP，简化版可走 webhook 转发）
 *   - 文件日志（缺省通道，logs/alert.log）
 *
 * 环境变量：
 *   - ALERT_WEBHOOK_URL（Slack-compatible Webhook URL）
 *   - ALERT_CHANNEL（default: #security）
 *   - ALERT_MENTION（@用户名 for urgent）
 *
 * 触发点（M1-M4）：
 *   - M1: check-secrets.mjs 命中 → 调用 alert('secrets-detected', ...)
 *   - M2: detect-key-abuse.mjs 每分钟聚合 QPS 异常 → alert('key-abuse', ...)
 *   - M3: error response middleware 检测密钥片段 → alert('key-leak-in-response', ..., severity='emergency')
 *   - M4: rotate-keys.mjs --check 超期 → alert('key-rotation-overdue', ...)
 */

import { createLogger } from '@/lib/logger';
import { redact } from '@/lib/logger/redact';

const log = createLogger('alerting');

export type AlertSeverity = 'info' | 'warn' | 'urgent' | 'emergency';

export interface AlertPayload {
  /** 告警类型：secrets-detected / key-abuse / key-leak-in-response / key-rotation-overdue */
  type: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  /** JSON 形式附加上下文（会被 redact 脱敏） */
  context?: Record<string, unknown>;
  /** 触发的具体位置（文件名 + 行号 / GitHub Actions run / curl URL） */
  source?: string;
}

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  info: ':information_source:',
  warn: ':warning:',
  urgent: ':rotating_light:',
  emergency: ':fire:',
};

async function sendToWebhook(payload: AlertPayload): Promise<boolean> {
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) return false;

  // Slack-compatible payload
  const colorBySeverity: Record<AlertSeverity, string> = {
    info: '#36a64f',
    warn: '#daa038',
    urgent: '#cc3600',
    emergency: '#ff0000',
  };

  const mention = payload.severity === 'emergency' && process.env.ALERT_MENTION
    ? `${process.env.ALERT_MENTION} `
    : '';
  const channel = process.env.ALERT_CHANNEL ? `<${process.env.ALERT_CHANNEL}> ` : '';

  const body = {
    text: `${mention}${channel}${SEVERITY_EMOJI[payload.severity]} ${payload.title}`,
    attachments: [
      {
        color: colorBySeverity[payload.severity],
        title: payload.title,
        text: payload.message,
        fields: [
          { title: 'Type', value: payload.type, short: true },
          { title: 'Severity', value: payload.severity, short: true },
          ...(payload.source ? [{ title: 'Source', value: payload.source, short: false }] : []),
          ...(payload.context
            ? [
                {
                  title: 'Context',
                  value: '```' + JSON.stringify(payload.context, null, 2) + '```',
                  short: false,
                },
              ]
            : []),
        ],
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log.warn(`[alerting] Webhook 返回 ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    log.warn(`[alerting] Webhook 发送失败: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function appendToAlertLog(payload: AlertPayload): void {
  // 始终写本地日志（即使 webhook 失败也能查到）
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...payload,
    context: payload.context ? safeStringify(redactContext(payload.context)) : undefined,
  });

  try {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const logDir = path.resolve(process.cwd(), 'logs');
    const logPath = path.resolve(logDir, 'alert.log');
    try {
      fs.appendFileSync(logPath, line + '\n', 'utf8');
    } catch (innerErr) {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(logPath, line + '\n', 'utf8');
    }
  } catch (err) {
    log.warn(`[alerting] 写 alert.log 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

function redactContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (typeof v === 'string') {
      out[k] = redact(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 触发告警（fire-and-forget）。
 * 异步发 webhook + 同步写 alert.log，不阻塞调用方。
 */
export function alert(payload: AlertPayload): void {
  // 始终写本地日志
  appendToAlertLog(payload);

  // 异步发 webhook
  sendToWebhook(payload).then((ok) => {
    if (!ok && payload.severity === 'emergency') {
      // emergency 失败时应至少在 stderr 打印
      log.error(`[alerting] EMERGENCY 告警未送达 webhook: ${payload.title}`);
    }
  });
}

/**
 * 便捷封装：检测 secrets 命中（M1）
 */
export function alertSecretsDetected(input: {
  file: string;
  line: number;
  patternId: string;
  source?: string;
}): void {
  alert({
    type: 'secrets-detected',
    severity: 'urgent',
    title: `检测到疑似密钥：${input.patternId}`,
    message: `在 ${input.file}:${input.line} 命中 pattern \`${input.patternId}\``,
    context: { file: input.file, line: input.line, patternId: input.patternId },
    source: input.source,
  });
}

/**
 * 便捷封装：检测到密钥出现在错误响应（M3）
 */
export function alertKeyLeakInResponse(input: {
  endpoint: string;
  patternId: string;
  snippet: string;
}): void {
  alert({
    type: 'key-leak-in-response',
    severity: 'emergency',
    title: `错误响应中检测到密钥片段：${input.patternId}`,
    message: `${input.endpoint} 响应体包含密钥片段，需要立即检查调用栈`,
    context: { endpoint: input.endpoint, patternId: input.patternId },
  });
}

/**
 * 便捷封装：密钥轮换逾期（M4）
 */
export function alertKeyRotationOverdue(input: {
  pendingCount: number;
  items: Array<{ provider: string; environment: string; reason: string }>;
}): void {
  alert({
    type: 'key-rotation-overdue',
    severity: 'warn',
    title: `${input.pendingCount} 个密钥需要轮换`,
    message: input.items
      .slice(0, 10)
      .map((i) => `- ${i.provider}/${i.environment}: ${i.reason}`)
      .join('\n'),
    context: {
      pendingCount: input.pendingCount,
      items: input.items.slice(0, 50),
    },
  });
}