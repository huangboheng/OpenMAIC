#!/usr/bin/env node
// scripts/verify-tar-clean.mjs
//
// 验证 tar 包不含敏感文件（.env* / server-providers*.yml）。
// 在 pack-deploy 之前跑，作为部署前的最后一道闸。
//
// Usage:
//   node scripts/verify-tar-clean.mjs <tar-file> [<tar-file> ...]
//   node scripts/verify-tar-clean.mjs --json      JSON 输出（CI 用）
//
// Exit 0: 所有 tar 包干净
// Exit 1: 至少一个 tar 包包含敏感文件
// Exit 2: 参数错误 / 文件读取失败

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const JSON_OUTPUT = args.includes('--json');
const tarFiles = args.filter((a) => !a.startsWith('--'));

const NO_COLOR = process.env.NO_COLOR === '1' || !process.stdout.isTTY;
const C = {
  red: (s) => (NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`),
  yellow: (s) => (NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`),
  green: (s) => (NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`),
  bold: (s) => (NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`),
  dim: (s) => (NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`),
};

// 敏感文件模式（路径中的任意位置匹配）
const SENSITIVE_PATTERNS = [
  { pattern: /(^|\/)\.env(\.|$)/, label: '.env*', severity: 'high' },
  { pattern: /(^|\/)\.env\.secrets/, label: '.env.secrets', severity: 'high' },
  { pattern: /(^|\/)\.env\.local/, label: '.env.local', severity: 'high' },
  { pattern: /(^|\/)\.env\.production/, label: '.env.production', severity: 'high' },
  { pattern: /(^|\/)server-providers[^/]*\.yml$/, label: 'server-providers*.yml', severity: 'high' },
];

function listTarEntries(tarPath) {
  try {
    const out = execFileSync('tar', ['-tzf', tarPath], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    });
    return out.split('\n').map((e) => e.replace(/\r$/, '')).filter(Boolean);
  } catch (err) {
    console.error(`[verify-tar-clean] ERROR — 无法读取 tar: ${tarPath}: ${err.message}`);
    return null;
  }
}

function scanEntries(entries) {
  // 按 entry 去重（同一文件被多个 pattern 命中只算一次）
  const seen = new Set();
  const hits = [];
  for (const entry of entries) {
    for (const { pattern, label, severity } of SENSITIVE_PATTERNS) {
      if (pattern.test(entry)) {
        if (seen.has(entry)) break; // 同一 entry 已报告，跳过
        seen.add(entry);
        hits.push({ entry, pattern: label, severity });
        break; // 一条 entry 只报一次
      }
    }
  }
  return hits;
}

function main() {
  if (tarFiles.length === 0) {
    console.error('Usage: node scripts/verify-tar-clean.mjs <tar-file> [<tar-file> ...]');
    process.exit(2);
  }

  const results = [];
  for (const tar of tarFiles) {
    const absTar = resolve(tar);
    if (!existsSync(absTar)) {
      console.error(`[verify-tar-clean] ERROR — 文件不存在: ${absTar}`);
      process.exit(2);
    }
    const entries = listTarEntries(absTar);
    if (entries === null) process.exit(2);
    const hits = scanEntries(entries);
    results.push({ tar: absTar, totalEntries: entries.length, hits });
  }

  const totalHits = results.reduce((sum, r) => sum + r.hits.length, 0);

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({ ok: totalHits === 0, results }, null, 2));
  } else {
    console.log(`[verify-tar-clean] 验证 ${results.length} 个 tar 包...`);
    for (const r of results) {
      if (r.hits.length === 0) {
        console.log(C.green(`  PASS ${r.tar} (${r.totalEntries} entries, 干净)`));
      } else {
        console.log(C.red(`  FAIL ${r.tar} (${r.totalEntries} entries, 含 ${r.hits.length} 处敏感文件)`));
        for (const h of r.hits) {
          console.log(C.yellow(`    [${h.severity}] ${h.entry}（匹配 ${h.pattern}）`));
        }
      }
    }
    console.log('');
    if (totalHits === 0) {
      console.log(C.green(`[verify-tar-clean] OK — 所有 tar 包均干净`));
    } else {
      console.log(C.red(`[verify-tar-clean] FAILED — 共 ${totalHits} 处敏感文件泄漏`));
      console.log(
        C.yellow(`修复建议：检查 .gitignore + .rsync-exclude 是否排除上述文件；pack 脚本可能错误地包含本地密钥`),
      );
    }
  }

  process.exit(totalHits === 0 ? 0 : 1);
}

main();