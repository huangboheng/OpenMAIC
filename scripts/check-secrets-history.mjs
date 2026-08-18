#!/usr/bin/env node
// scripts/check-secrets-history.mjs
//
// git 历史回扫 — 扫描 git log -p 输出，定位旧 commit 中可能泄漏的密钥。
// 共享 lib/secrets-scanner.mjs 的扫描逻辑，确保规则一致。
//
// Usage:
//   node scripts/check-secrets-history.mjs                 扫描最近 24 个月
//   node scripts/check-secrets-history.mjs --months N      扫描最近 N 个月（默认 24）
//   node scripts/check-secrets-history.mjs --ref <ref>     扫描指定 ref 之后（默认 HEAD）
//   node scripts/check-secrets-history.mjs --since <hash>  扫描指定 commit 之后
//   node scripts/check-secrets-history.mjs --max-commits N 限制最多扫描 commit 数（防止大仓库超时）
//   node scripts/check-secrets-history.mjs --json          JSON 输出
//
// Exit 0: 历史未发现密钥
// Exit 1: 发现密钥（输出报告）
// Exit 2: 参数错误 / 环境异常

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../lib/secrets-scanner.mjs';

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

// ---------- 参数解析 ----------

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const NO_COLOR = flags.has('--ci') || process.env.NO_COLOR === '1' || !process.stdout.isTTY;
const JSON_OUTPUT = flags.has('--json');
const ref = flagValue('--ref') || 'HEAD';
const sinceHash = flagValue('--since');
const months = Number.parseInt(flagValue('--months') || '24', 10);
const maxCommits = Number.parseInt(flagValue('--max-commits') || '10000', 10);

// ---------- 颜色 ----------

const C = {
  red: (s) => (NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`),
  yellow: (s) => (NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`),
  green: (s) => (NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`),
  dim: (s) => (NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`),
  bold: (s) => (NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`),
};

// ---------- Git 收集 ----------

function git(args) {
  try {
    return {
      text: execFileSync('git', args, {
        cwd: projectRoot,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      }),
    };
  } catch (err) {
    return { error: err };
  }
}

function buildLogArgs() {
  const gitArgs = ['log', ref, '--no-color', '--pretty=format:---COMMIT---%n%H%n%an%n%aI', '-p', '--diff-filter=ACMR'];
  if (sinceHash) {
    gitArgs.push(`${sinceHash}..${ref}`);
  } else if (months > 0) {
    gitArgs.push(`--since=${months}.months ago`);
  }
  return gitArgs;
}

function parseLog(raw) {
  // 格式：
  //   ---COMMIT---
  //   <hash>
  //   <author>
  //   <iso date>
  //   <diff content>
  const lines = [];
  const result = [];
  let curHash = null;
  let curAuthor = null;
  let curDate = null;
  let curFile = null;
  let curLine = 1;

  for (const line of raw.split('\n')) {
    if (line === '---COMMIT---') {
      curHash = null;
      curAuthor = null;
      curDate = null;
      continue;
    }
    if (curHash === null) {
      curHash = line;
      continue;
    }
    if (curAuthor === null) {
      curAuthor = line;
      continue;
    }
    if (curDate === null) {
      curDate = line;
      continue;
    }

    // diff 内容
    if (line.startsWith('+++ b/')) {
      curFile = line.slice(6);
      curLine = 1;
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      curLine = Number(hunk[1]) || 1;
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++') && curFile) {
      // 用 commit hash + 文件 + 行号作为 file 标识，便于溯源
      const fileId = `${curHash.slice(0, 8)}:${curFile}`;
      result.push({
        file: fileId,
        line: curLine,
        text: line.slice(1),
        _meta: { hash: curHash, author: curAuthor, date: curDate, path: curFile },
      });
      curLine += 1;
    }
  }
  return result;
}

// ---------- Main ----------

function main() {
  const gitArgs = buildLogArgs();
  const log = git(gitArgs);
  if (log.error) {
    console.error('[check-secrets-history] ERROR — git log 失败:', log.error.message);
    process.exit(2);
  }

  const lines = parseLog(log.text);

  // commit 数量上限保护
  const uniqueCommits = new Set(lines.map((l) => l._meta?.hash).filter(Boolean));
  if (uniqueCommits.size > maxCommits) {
    console.warn(
      C.yellow(
        `[check-secrets-history] 警告：扫描 ${uniqueCommits.size} 个 commit 超过 ${maxCommits} 上限，可能需要缩小时间窗`,
      ),
    );
  }

  const hits = scan(lines);

  // 为历史命中附加 commit 元信息
  const enriched = hits.map((h) => {
    const meta = lines.find((l) => `${l._meta?.hash?.slice(0, 8)}:${l._meta?.path}` === h.file)?._meta;
    return { ...h, commit: meta?.hash, author: meta?.author, date: meta?.date, path: meta?.path };
  });

  if (JSON_OUTPUT) {
    console.log(
      JSON.stringify(
        {
          scannedCommits: uniqueCommits.size,
          hitCount: enriched.length,
          hits: enriched,
        },
        null,
        2,
      ),
    );
  } else if (enriched.length === 0) {
    console.log(
      C.green(
        `[check-secrets-history] OK — 扫描最近 ${months} 个月（${uniqueCommits.size} commit）未发现密钥。`,
      ),
    );
  } else {
    console.log(
      C.red(
        `[check-secrets-history] FAILED — 历史中发现 ${enriched.length} 处疑似密钥（扫描 ${uniqueCommits.size} commit）：`,
      ),
    );
    console.log('');
    for (const h of enriched) {
      console.log(`  ${C.yellow(`[${h.id}]`)} ${C.bold(h.commit?.slice(0, 8))} ${h.path}:${h.line}`);
      console.log(`    作者: ${C.dim(h.author)}  日期: ${C.dim(h.date)}`);
      console.log(`    匹配: ${C.dim(h.match)}`);
      console.log(`    内容: ${C.dim(h.snippet)}`);
      console.log(`    建议: ${h.hint}`);
      console.log('');
    }
    console.log(
      C.yellow(
        '如确认是历史 commit 中的密钥泄漏，请立即执行 IR Playbook（docs/security/incident-response-playbook.md）：',
      ),
    );
    console.log(C.dim('  1. 吊销 provider 控制台的密钥'));
    console.log(C.dim('  2. 用 BFG 或 git filter-repo 清理历史'));
    console.log(C.dim('  3. 部署新密钥到所有环境'));
  }

  process.exit(enriched.length === 0 ? 0 : 1);
}

main();
