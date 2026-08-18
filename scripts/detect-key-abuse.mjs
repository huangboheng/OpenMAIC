#!/usr/bin/env node
// scripts/detect-key-abuse.mjs
//
// 离线分析 key-audit.log，检测异常调用模式（阶段 6 M2）。
//
// 用法：
//   node scripts/detect-key-abuse.mjs                        分析 logs/key-audit.log
//   node scripts/detect-key-abuse.mjs --window 5             5 分钟聚合窗口（默认 1）
//   node scripts/detect-key-abuse.mjs --threshold 3          P99 × 阈值（默认 3）
//   node scripts/detect-key-abuse.mjs --json                 JSON 输出
//   node scripts/detect-key-abuse.mjs --alert                触发告警 webhook（需 ALERT_WEBHOOK_URL）
//
// 检测规则（M2）：
//   - 同 provider × fingerprint 的 QPS > 历史 P99 × threshold → 告警
//   - 同一 provider 在 < 60s 内被多个 IP 调用 → 异常（暂未实现，需 IP 信息）
//
// Exit 0: 无异常
// Exit 1: 检测到异常调用模式

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const JSON_OUTPUT = args.includes('--json');
const ALERT_MODE = args.includes('--alert');
const NO_COLOR = process.env.NO_COLOR === '1' || !process.stdout.isTTY;

const windowArg = args.indexOf('--window');
const WINDOW_MIN = windowArg >= 0 ? Number.parseInt(args[windowArg + 1], 10) : 1;

const thresholdArg = args.indexOf('--threshold');
const THRESHOLD_MULT = thresholdArg >= 0 ? Number.parseFloat(args[thresholdArg + 1]) : 3;

const C = {
  red: (s) => (NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`),
  yellow: (s) => (NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`),
  green: (s) => (NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`),
  dim: (s) => (NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`),
  bold: (s) => (NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`),
};

const projectRoot = resolve(process.cwd());
const LOG_PATH = resolve(projectRoot, 'logs/key-audit.log');

function parseAuditLog(content) {
  const events = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed);
      events.push(e);
    } catch {
      // skip malformed line
    }
  }
  return events;
}

function aggregateByWindow(events, windowMs) {
  // 按 (provider, fingerprint, windowStart) 分组计数
  const buckets = new Map();
  for (const e of events) {
    const ts = new Date(e.ts).getTime();
    if (!Number.isFinite(ts)) continue;
    const windowStart = Math.floor(ts / windowMs) * windowMs;
    const key = `${e.provider}|${e.fp}|${windowStart}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return Array.from(buckets.entries()).map(([k, count]) => {
    const [provider, fp, windowStart] = k.split('|');
    return { provider, fingerprint: fp, windowStart: Number(windowStart), qps: count };
  });
}

function detectAbuse(aggregated, thresholdMult) {
  // 按 (provider, fingerprint) 分组 → 计算 P99 → 检测超 P99 * threshold 的窗口
  const byKey = new Map();
  for (const row of aggregated) {
    const k = `${row.provider}|${row.fingerprint}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(row.qps);
  }

  const anomalies = [];
  for (const [k, qpsList] of byKey) {
    const sorted = [...qpsList].sort((a, b) => a - b);
    const p99Idx = Math.floor(sorted.length * 0.99);
    const p99 = sorted[p99Idx] ?? sorted[sorted.length - 1] ?? 0;
    const threshold = Math.max(p99 * thresholdMult, 10);
    for (const row of aggregated) {
      if (`${row.provider}|${row.fingerprint}` !== k) continue;
      if (row.qps > threshold) {
        anomalies.push({
          provider: row.provider,
          fingerprint: row.fingerprint,
          windowStart: new Date(row.windowStart).toISOString(),
          qps: row.qps,
          threshold,
          p99,
        });
      }
    }
  }
  return anomalies;
}

async function sendAlert(anomalies) {
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) return false;

  const body = {
    text: `:rotating_light: detect-key-abuse 发现 ${anomalies.length} 处异常 QPS`,
    attachments: [
      {
        color: '#cc3600',
        title: 'API Key 异常流量检测',
        text: anomalies
          .slice(0, 10)
          .map((a) => `- ${a.provider} (fp=${a.fingerprint}): QPS=${a.qps} > threshold=${a.threshold} at ${a.windowStart}`)
          .join('\n'),
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
    return res.ok;
  } catch {
    return false;
  }
}

function main() {
  if (!existsSync(LOG_PATH)) {
    console.error(C.yellow(`[detect-key-abuse] WARN — 未找到 ${LOG_PATH}，跳过`));
    console.error('提示：先确保 provider-config.ts 已启用 key-audit（阶段 5）');
    process.exit(0);
  }

  const stat = statSync(LOG_PATH);
  if (stat.size === 0) {
    console.log(C.dim('[detect-key-abuse] 日志为空，跳过'));
    process.exit(0);
  }

  const content = readFileSync(LOG_PATH, 'utf8');
  const events = parseAuditLog(content);

  if (events.length === 0) {
    console.log(C.dim('[detect-key-abuse] 无可分析事件，跳过'));
    process.exit(0);
  }

  const WINDOW_MS = WINDOW_MIN * 60 * 1000;
  const aggregated = aggregateByWindow(events, WINDOW_MS);
  const anomalies = detectAbuse(aggregated, THRESHOLD_MULT);

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({
      eventCount: events.length,
      windowMinutes: WINDOW_MIN,
      thresholdMult: THRESHOLD_MULT,
      anomalyCount: anomalies.length,
      anomalies,
    }, null, 2));
  } else {
    console.log(`[detect-key-abuse] 分析 ${events.length} 条审计事件（窗口 ${WINDOW_MIN} 分钟，阈值 P99×${THRESHOLD_MULT}）...`);
    if (anomalies.length === 0) {
      console.log(C.green('[detect-key-abuse] OK — 未检测到异常 QPS 模式'));
    } else {
      console.log(C.red(`[detect-key-abuse] FAILED — 发现 ${anomalies.length} 处异常：\n`));
      for (const a of anomalies) {
        console.log(C.yellow(`  ${a.provider} (fp=${a.fingerprint}) QPS=${a.qps} > ${a.threshold} (P99=${a.p99}) at ${a.windowStart}`));
      }
    }
  }

  if (ALERT_MODE && anomalies.length > 0) {
    sendAlert(anomalies).then((ok) => {
      if (!ok) console.error(C.yellow('[detect-key-abuse] 告警未送达（缺 ALERT_WEBHOOK_URL 或 webhook 失败）'));
    });
  }

  process.exit(anomalies.length === 0 ? 0 : 1);
}

main();