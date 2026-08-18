#!/usr/bin/env node
// scripts/rotate-keys.mjs
//
// 密钥轮换清单生成器。基于 inventory + key-owners-roster 计算待轮换密钥。
//
// Usage:
//   node scripts/rotate-keys.mjs                       列出所有超期 / 即将到期密钥
//   node scripts/rotate-keys.mjs --max-days 90         自定义阈值（默认 90 天）
//   node scripts/rotate-keys.mjs --json               JSON 输出
//   node scripts/rotate-keys.mjs --check              退出码 0=无待轮换，1=有
//
// 数据来源：
//   - inventory：node scripts/api-key-inventory.mjs --json
//   - roster：docs/security/key-owners-roster.md（人工维护）
//
// 注意：本脚本**不会**自动轮换密钥，只是提醒。

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const JSON_OUTPUT = args.includes('--json');
const CHECK_MODE = args.includes('--check');
const NO_COLOR = process.env.NO_COLOR === '1' || !process.stdout.isTTY;

const C = {
  green: (s) => (NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`),
  yellow: (s) => (NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`),
  red: (s) => (NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`),
  dim: (s) => (NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`),
  bold: (s) => (NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`),
};

const projectRoot = resolve(process.cwd());

const maxDaysArg = args.indexOf('--max-days');
const MAX_DAYS = maxDaysArg >= 0 ? Number.parseInt(args[maxDaysArg + 1], 10) : 90;

// 解析 key-owners-roster.md
function parseRoster() {
  const rosterPath = resolve(projectRoot, 'docs/security/key-owners-roster.md');
  if (!existsSync(rosterPath)) return [];

  const content = readFileSync(rosterPath, 'utf8');
  const lines = content.split('\n');
  const entries = [];
  let inTable = false;

  for (const line of lines) {
    if (line.includes('| Provider |') || line.includes('|----------|')) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.trim().startsWith('|')) {
      inTable = false;
      continue;
    }

    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 7) continue;
    const [_, provider, environment, owner, fingerprintPrefix, lastRotated, nextRotate, ...rest] = cells;
    const scope = rest[0];
    const status = rest[1];

    // 跳过占位符（未填写）
    if (lastRotated === '(待定)' || lastRotated === '(待 inventory)' || lastRotated === '(unknown)') continue;
    if (nextRotate === '(待定)' || lastRotated === '*') continue;

    entries.push({
      provider,
      environment,
      owner,
      fingerprintPrefix,
      lastRotated,
      nextRotate,
      scope,
      status,
    });
  }
  return entries;
}

function daysSince(dateStr) {
  // 处理 * 标记（如 "2026-07-31*"）
  const cleaned = dateStr.replace(/\*$/, '');
  const date = new Date(cleaned);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const diff = now - date;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function daysUntil(dateStr) {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  return Math.ceil((date - now) / (1000 * 60 * 60 * 24));
}

function buildRotationPlan(roster) {
  const plan = [];
  for (const entry of roster) {
    const daysSinceRotated = daysSince(entry.lastRotated);
    const daysUntilNext = daysUntil(entry.nextRotate);

    // 跳过非 active 状态（但包含"泄漏"标记的也保留）
    const isLeaked = entry.status && entry.status.includes('泄漏');
    const isActive = entry.status && entry.status.startsWith('active');
    if (!isActive && !isLeaked) continue;

    let priority = 'normal';
    let reason = '';

    if (isLeaked) {
      priority = 'immediate';
      reason = '已知泄漏，需立即处置';
    } else if (daysSinceRotated === null) {
      reason = `无法解析 lastRotated: ${entry.lastRotated}`;
      priority = 'unknown';
    } else if (daysSinceRotated >= MAX_DAYS) {
      priority = 'overdue';
      reason = `已轮换 ${daysSinceRotated} 天（>${MAX_DAYS} 天）`;
    } else if (daysSinceRotated >= MAX_DAYS * 0.8) {
      priority = 'urgent';
      reason = `已轮换 ${daysSinceRotated} 天（接近 ${MAX_DAYS} 天上限）`;
    } else if (daysUntilNext !== null && daysUntilNext <= 7) {
      priority = 'soon';
      reason = `${daysUntilNext} 天后到期`;
    }

    if (priority !== 'normal') {
      plan.push({
        ...entry,
        priority,
        reason,
        daysSinceRotated,
        daysUntilNext,
      });
    }
  }
  return plan.sort((a, b) => {
    const order = { immediate: 0, overdue: 1, urgent: 2, soon: 3, unknown: 4 };
    return order[a.priority] - order[b.priority];
  });
}

function main() {
  const roster = parseRoster();
  if (roster.length === 0) {
    console.error(C.yellow('[rotate-keys] WARN — 未找到 docs/security/key-owners-roster.md 或内容为空'));
    console.error('请先填写 roster，再跑 rotate-keys。');
    if (CHECK_MODE) process.exit(1);
    if (!JSON_OUTPUT) {
      console.log(JSON.stringify({ pending: [], rosterSize: 0 }, null, 2));
    }
    process.exit(0);
  }

  const plan = buildRotationPlan(roster);

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({
      pendingCount: plan.length,
      rosterSize: roster.length,
      maxDays: MAX_DAYS,
      items: plan,
    }, null, 2));
  } else {
    console.log(`[rotate-keys] 扫描 ${roster.length} 条 roster 记录（阈值 ${MAX_DAYS} 天）...`);
    console.log('');

    if (plan.length === 0) {
      console.log(C.green(`[rotate-keys] OK — 无待轮换密钥`));
    } else {
      console.log(C.bold(`[rotate-keys] 待轮换 ${plan.length} 条：\n`));
      for (const item of plan) {
        const color = item.priority === 'immediate' ? C.red : item.priority === 'overdue' ? C.red : item.priority === 'urgent' ? C.yellow : C.dim;
        console.log(color(`  [${item.priority.toUpperCase()}] ${item.provider}/${item.environment} (owner=${item.owner})`));
        console.log(color(`    reason: ${item.reason}`));
        console.log(color(`    fingerprint prefix: ${item.fingerprintPrefix}`));
        console.log(color(`    lastRotated: ${item.lastRotated}`));
        if (item.daysUntilNext !== null && Number.isFinite(item.daysUntilNext)) {
          console.log(color(`    daysUntilNext: ${item.daysUntilNext}`));
        }
        console.log('');
      }
      console.log(C.yellow(`[rotate-keys] 提示：轮换 SOP 见 docs/security/api-key-model.md`));
    }
  }

  if (CHECK_MODE) {
    process.exit(plan.length > 0 ? 1 : 0);
  }
  process.exit(0);
}

main();