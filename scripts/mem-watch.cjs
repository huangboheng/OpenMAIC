#!/usr/bin/env node
/**
 * mem-watch.cjs
 *
 * 轻量内存采样器：每 INTERVAL（默认 30s）用 tasklist 快照一次系统进程，
 * 按进程名聚合 Top 10，并记录 QoderCN / node / chrome / WeChat 分组小计，
 * 追加写入 logs/mem-watch.log，用于定位内存爆发性增长的归属。
 *
 * 用法：
 *   node scripts/mem-watch.cjs                 # 前台运行（Ctrl+C 退出）
 *   node scripts/mem-watch.cjs --interval=10   # 每 10s 采样一次
 *   node scripts/mem-watch.cjs --duration=20   # 运行 20 分钟后自动退出
 *
 * 日志格式（单行 JSON，便于 grep/回放）：
 *   {"ts":"...","totalMB":..,"freeMB":..,"groups":{"QoderCN":..,"node":..},
 *    "top":[{"name":"...","count":..,"mb":..}]}
 */

const { execFileSync } = require('child_process');
const { appendFileSync, mkdirSync } = require('fs');
const { join } = require('path');
const os = require('os');

const ROOT = join(__dirname, '..');
const LOG_FILE = join(ROOT, 'logs', 'mem-watch.log');

const args = process.argv.slice(2);
const intervalSec = Number(
  args.find((a) => a.startsWith('--interval='))?.split('=')[1] ?? 30,
);
const durationMin = Number(
  args.find((a) => a.startsWith('--duration='))?.split('=')[1] ?? 0,
);

const GROUP_RULES = [
  { group: 'QoderCN', match: /^QoderCN$/i },
  { group: 'node', match: /^node$/i },
  { group: 'chrome', match: /^chrome$/i },
  { group: 'WeChat', match: /^(Weixin|WeChatAppEx)$/i },
  { group: 'Defender', match: /^MsMpEng$/i },
  { group: 'MemCompress', match: /^Memory Compression$/i },
];

function snapshot() {
  // tasklist CSV: "Name","PID","SessionName","Session#","Mem Usage"
  const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const map = new Map();
  for (const line of out.trim().split(/\r?\n/)) {
    const parts = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (parts.length < 5) continue;
    const kb = parseInt(parts[4].replace(/[^\d]/g, ''), 10);
    if (Number.isNaN(kb)) continue;
    const name = parts[0].replace(/\.exe$/i, '');
    const cur = map.get(name) || { count: 0, mb: 0 };
    cur.count += 1;
    cur.mb += kb / 1024;
    map.set(name, cur);
  }
  return map;
}

function buildRecord(map) {
  const top = [...map.entries()]
    .sort((a, b) => b[1].mb - a[1].mb)
    .slice(0, 10)
    .map(([name, v]) => ({ name, count: v.count, mb: Math.round(v.mb) }));

  const groups = {};
  for (const { group, match } of GROUP_RULES) {
    let mb = 0;
    let count = 0;
    for (const [name, v] of map.entries()) {
      if (match.test(name)) {
        mb += v.mb;
        count += v.count;
      }
    }
    groups[group] = { count, mb: Math.round(mb) };
  }

  const totalMB = [...map.values()].reduce((s, v) => s + v.mb, 0);
  const totalPhysMB = os.totalmem() / 1024 / 1024;
  const freePhysMB = os.freemem() / 1024 / 1024;

  return {
    ts: new Date().toISOString(),
    totalMB: Math.round(totalMB),
    physUsedPct: Math.round(((totalPhysMB - freePhysMB) / totalPhysMB) * 100),
    groups,
    top,
  };
}

function main() {
  mkdirSync(join(ROOT, 'logs'), { recursive: true });
  const startedAt = Date.now();
  appendFileSync(LOG_FILE, `# mem-watch started ${new Date().toISOString()} interval=${intervalSec}s duration=${durationMin || 'inf'}min\n`);
  console.log(`mem-watch: sampling every ${intervalSec}s -> logs/mem-watch.log (Ctrl+C to stop)`);

  const timer = setInterval(() => {
    try {
      const record = buildRecord(snapshot());
      appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
      const g = record.groups;
      console.log(
        `[${record.ts.slice(11, 19)}] phys=${record.physUsedPct}% ` +
          `Qoder=${g.QoderCN.mb}MB(${g.QoderCN.count}) node=${g.node.mb}MB(${g.node.count}) ` +
          `chrome=${g.chrome.mb}MB WeChat=${g.WeChat.mb}MB Defender=${g.Defender.mb}MB ` +
          `top1=${record.top[0]?.name}:${record.top[0]?.mb}MB`,
      );
    } catch (err) {
      console.error(`mem-watch sample failed: ${err.message}`);
    }
    if (durationMin > 0 && Date.now() - startedAt >= durationMin * 60_000) {
      appendFileSync(LOG_FILE, `# mem-watch finished ${new Date().toISOString()}\n`);
      clearInterval(timer);
      process.exit(0);
    }
  }, intervalSec * 1000);
}

main();
