#!/usr/bin/env node
// scripts/check-secrets.mjs
//
// Secrets 扫描钩子（薄包装）— 防止真实 API KEY 误提交到仓库。
// 在 pre-commit 阶段运行；命中风险模式时阻断提交，支持逃生口：
//   SECRETS_SCAN_APPROVED=1  显式审批放行（与 RISK_APPROVED 风格一致）
//   SECRETS_SCAN_DISABLED=1  完全跳过本次扫描
//
// Usage:
//   node scripts/check-secrets.mjs                   默认：扫描 staged 变更
//   node scripts/check-secrets.mjs --all-files       扫描工作区全部文件（CI 用）
//   node scripts/check-secrets.mjs --since-ref <ref> 扫描指定 ref 之后的变更
//   node scripts/check-secrets.mjs --ci              CI 模式（fail-fast，无颜色）
//   node scripts/check-secrets.mjs --json            JSON 输出（便于工具消费）
//   node scripts/check-secrets.mjs --self-test       跑内置基准（误报率验证）
//   node scripts/check-secrets.mjs --scan-file <p>   扫描指定文件（调试用）
//
// Exit 0: 未命中
// Exit 1: 命中（输出报告）
// Exit 2: 参数错误 / 环境异常

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, fixtureLines } from '../lib/secrets-scanner.mjs';

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

// ---------- 参数解析 ----------

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const MODE_ALL_FILES = flags.has('--all-files');
const MODE_CI = flags.has('--ci');
const JSON_OUTPUT = flags.has('--json');
const SELF_TEST = flags.has('--self-test');
const NO_COLOR = MODE_CI || process.env.NO_COLOR === '1' || !process.stdout.isTTY;
const sinceRef = flagValue('--since-ref');
const scanFilePath = flagValue('--scan-file');
const DISABLED = process.env.SECRETS_SCAN_DISABLED === '1';
const APPROVED = process.env.SECRETS_SCAN_APPROVED === '1';

// ---------- 颜色工具 ----------

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

function collectFromGit() {
  const records = [];

  if (MODE_ALL_FILES || sinceRef) {
    const ref = sinceRef || 'HEAD';
    const diff = git(['diff', `${ref}`, '--unified=0', '--no-color', '--diff-filter=ACMR']);
    if (diff.error) {
      console.error('[check-secrets] ERROR — git diff 失败:', diff.error.message);
      process.exit(2);
    }
    return parseUnifiedDiff(diff.text);
  }

  const initialCommit = (() => {
    const r = git(['rev-parse', 'HEAD']);
    return !!r.error;
  })();

  if (initialCommit) {
    const r = git(['ls-files', '-z']);
    if (r.error) {
      console.error('[check-secrets] ERROR — git ls-files 失败:', r.error.message);
      process.exit(2);
    }
    for (const path of r.text.split('\0')) {
      if (path) records.push({ path, status: 'A' });
    }
  } else {
    const r = git(['diff', '--cached', '--name-status', '-z']);
    if (r.error) {
      console.error('[check-secrets] ERROR — git diff --cached 失败:', r.error.message);
      process.exit(2);
    }
    const parts = r.text.split('\0').filter(Boolean);
    for (let i = 0; i < parts.length; ) {
      const status = parts[i++];
      const path = parts[i++];
      if (/^[RC]/.test(status)) records.push({ status: status[0], path: parts[i++] });
      else records.push({ status: status[0], path });
    }
  }

  const added = records.filter((r) => ['A', 'C', 'R'].includes(r.status));
  const result = [];
  for (const r of added) {
    const fullPath = join(projectRoot, r.path);
    if (!existsSync(fullPath)) continue;
    const content = readFileSync(fullPath, 'utf8');
    content.split('\n').forEach((line, idx) => {
      result.push({ file: r.path, line: idx + 1, text: line });
    });
  }
  return result;
}

function parseUnifiedDiff(diffText) {
  const result = [];
  let curFile = null;
  let curLine = 1;
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('+++ b/')) {
      curFile = raw.slice(6);
      curLine = 1;
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      curLine = Number(hunk[1]) || 1;
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++') && curFile) {
      result.push({ file: curFile, line: curLine, text: raw.slice(1) });
      curLine += 1;
    }
  }
  return result;
}

function collectFromFiles(filePaths) {
  // --scan-file 模式或 self-test 模式：扫描指定文件
  const result = [];
  const filesToScan = filePaths && filePaths.length > 0
    ? filePaths.map((p) => resolve(p))
    : [
        join(projectRoot, '.env.example'),
        join(projectRoot, 'scripts', 'check-secrets.mjs'),
      ];
  for (const f of filesToScan) {
    if (!existsSync(f)) continue;
    const content = readFileSync(f, 'utf8');
    content.split('\n').forEach((text, idx) => {
      result.push({ file: relative(projectRoot, f) || f, line: idx + 1, text });
    });
  }
  return result;
}

// ---------- 输出 ----------

function reportText(hits, mode) {
  const lines = [];
  if (hits.length === 0) {
    lines.push(C.green(`[check-secrets] OK — ${mode} 模式未命中任何密钥模式。`));
    return lines.join('\n');
  }
  lines.push(C.red(`[check-secrets] FAILED — ${mode} 模式命中 ${hits.length} 处疑似密钥：`));
  lines.push('');
  for (const h of hits) {
    lines.push(`  ${C.yellow(`[${h.id}]`)} ${C.bold(h.file)}:${h.line}`);
    lines.push(`    匹配: ${C.dim(h.match)}`);
    lines.push(`    内容: ${C.dim(h.snippet)}`);
    lines.push(`    建议: ${h.hint}`);
    lines.push('');
  }
  lines.push(C.yellow(`如确认非密钥（如测试 fixture、占位符等），可用 SECRETS_SCAN_APPROVED=1 显式放行：`));
  lines.push(C.dim(`  SECRETS_SCAN_APPROVED=1 git commit`));
  lines.push(C.dim(`完全跳过本次扫描：SECRETS_SCAN_DISABLED=1 git commit`));
  return lines.join('\n');
}

function reportJson(hits, mode) {
  return JSON.stringify({ mode, hitCount: hits.length, hits }, null, 2);
}

// ---------- 自测模式 ----------

function selfTest() {
  const lines = fixtureLines();
  const hits = scan(lines);

  const falsePositives = hits.filter((h) => h.file === 'fixture:placeholder');
  const expectedPatterns = ['openai-sk', 'anthropic-sk', 'aliyun-ak', 'aws-access-key', 'next-public-secret', 'bearer-token'];
  const truePositives = hits.filter((h) => h.file === 'fixture:real');
  const truePositivePatternIds = new Set(truePositives.map((h) => h.id));

  console.log(`[self-test] fixture 总行数: ${lines.length}`);
  console.log(`[self-test] 总命中: ${hits.length}`);
  console.log(`[self-test] 占位符误报: ${falsePositives.length}（应 = 0）${falsePositives.length === 0 ? '✓' : '✗'}`);
  console.log(`[self-test] 真实密钥命中 pattern: ${[...truePositivePatternIds].join(', ')}`);

  const missingExpected = expectedPatterns.filter((id) => !truePositivePatternIds.has(id));
  console.log(`[self-test] 真实密钥漏报 pattern: ${missingExpected.join(', ') || '无'}${missingExpected.length === 0 ? '✓' : '✗'}`);

  const realFileHits = collectFromFiles();
  const realHits = scan(realFileHits);
  const isEnvExampleClean = realHits.filter((h) => h.file.endsWith('.env.example')).length === 0;
  const isSelfClean = realHits.filter((h) => h.file.endsWith('check-secrets.mjs')).length === 0;
  console.log(`[self-test] .env.example 应零命中: ${isEnvExampleClean ? '✓' : '✗'}`);
  console.log(`[self-test] check-secrets.mjs 自指应零命中: ${isSelfClean ? '✓' : '✗'}`);

  const failed =
    falsePositives.length > 0 ||
    missingExpected.length > 0 ||
    !isEnvExampleClean ||
    !isSelfClean;
  if (failed) process.exit(1);
  console.log(C.green('[self-test] PASS'));
}

// ---------- Main ----------

function main() {
  if (DISABLED) {
    console.log('[check-secrets] SECRETS_SCAN_DISABLED=1 — 跳过扫描');
    process.exit(0);
  }

  if (SELF_TEST) {
    selfTest();
    return;
  }

  // --scan-file 模式（调试 / 独立验证）：直接扫描指定文件
  if (scanFilePath) {
    if (!existsSync(scanFilePath)) {
      console.error(`[check-secrets] --scan-file 指定的文件不存在: ${scanFilePath}`);
      process.exit(2);
    }
    const lines = collectFromFiles([scanFilePath]);
    const fileHits = scan(lines);
    const mode = '--scan-file';
    if (JSON_OUTPUT) console.log(reportJson(fileHits, mode));
    else console.log(reportText(fileHits, mode));
    process.exit(fileHits.length === 0 ? 0 : 1);
  }

  const mode = MODE_ALL_FILES ? '--all-files' : sinceRef ? `--since-ref=${sinceRef}` : 'staged';

  let lines;
  try {
    lines = collectFromGit();
  } catch (err) {
    console.error('[check-secrets] ERROR — 收集变更失败:', err.message);
    process.exit(2);
  }

  const hits = scan(lines);

  if (JSON_OUTPUT) {
    console.log(reportJson(hits, mode));
  } else {
    console.log(reportText(hits, mode));
  }

  if (hits.length === 0) process.exit(0);

  if (APPROVED) {
    console.warn(C.yellow(`[check-secrets] SECRETS_SCAN_APPROVED=1 — 已显式放行 ${hits.length} 处命中`));
    process.exit(0);
  }

  process.exit(1);
}

main();
