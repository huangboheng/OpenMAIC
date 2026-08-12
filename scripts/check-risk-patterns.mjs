#!/usr/bin/env node
// scripts/check-risk-patterns.mjs
//
// 风险感知提交检查（.githooks/pre-commit 硬门禁的一部分）：
//   1. tmp-* 前缀脚本禁止入库（见 .qoder/rules/tmp-script-governance.md）
//   2. 暂存变更新增行中的敏感模式：
//      - 自动接受主机密钥（StrictHostKeyChecking 置为 no / UserKnownHostsFile 指向 /dev/null）
//      - root 远程操作（ssh/scp/rsync ... root@）
//      - 硬编码生产主机（ssh/scp/rsync ... <IP>）
//   命中时阻断提交并要求人工评审；确认风险可控后，可用 RISK_APPROVED=1 显式审批放行。
//
// Usage:  node scripts/check-risk-patterns.mjs
// Exit 0: 未命中风险模式，或已显式审批（RISK_APPROVED=1）
// Exit 1: 命中风险模式，输出报告并阻断提交

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

// 显式审批逃生口：与 pre-push 的 SKIP_DIRTY=1 同一审批模式
const approved = process.env.RISK_APPROVED === '1';

// ---------- 规则定义 ----------

// tmp-* 脚本判定：scripts/ 目录下的任意 tmp-* 文件，或其他位置的脚本类 tmp-* 文件
const SCRIPT_EXT = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'mjs',
  'js',
  'cjs',
  'ts',
  'py',
  'ps1',
  'cmd',
  'bat',
  'rb',
  'pl',
]);

function isTmpScript(path) {
  const name = basename(path);
  if (!name.startsWith('tmp-')) return false;
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  const underScripts = path.split(/[\\/]/).includes('scripts');
  return underScripts || SCRIPT_EXT.has(ext);
}

// 纯文档不参与内容扫描，避免误伤说明性文本
const DOC_EXT = new Set(['md', 'markdown', 'txt', 'rst', 'adoc']);

function extOf(path) {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

// 敏感模式：仅匹配新增行；命令须位于行首或分号/管道/逻辑符/括号之后，
// 避免把注释、echo 文本等非执行位置误报为远程操作。
const CMD_PREFIX = '(?:^|[;&|({])\\s*';
const REMOTE_CMD = `${CMD_PREFIX}(?:ssh|scp|rsync)\\b`;

const RISK_PATTERNS = [
  {
    id: 'host-key-auto-accept',
    label: '自动接受主机密钥',
    regex: /StrictHostKeyChecking\s*=\s*(?:no|false)|UserKnownHostsFile\s*=\s*(?:\/dev\/null|NUL)/i,
    hint: '自动接受主机密钥会失去对端身份校验，暴露中间人攻击面；应使用 known_hosts 指纹校验',
  },
  {
    id: 'root-remote-ops',
    label: 'root 远程操作',
    regex: new RegExp(`${REMOTE_CMD}[^\\n;]*\\broot@`),
    hint: '远程命令直接以 root 身份执行；应使用最小权限账号，必要时经 sudo 提权',
  },
  {
    id: 'hardcoded-prod-host',
    label: '硬编码生产主机',
    regex: new RegExp(`${REMOTE_CMD}[^\\n;]*\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b`),
    hint: '远程命令硬编码主机 IP；应从环境变量/配置文件读取（如 DEPLOY_VPS_HOST）',
  },
];

// ---------- 收集暂存变更 ----------

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

const nameStatus = git(['diff', '--cached', '--name-status', '-z']);
const initialCommit = Boolean(nameStatus.error); // 无 HEAD（首次提交）

const records = [];
if (initialCommit) {
  const files = git(['ls-files', '-z']);
  if (files.error) {
    console.error('[check-risk-patterns] ERROR — 无法读取暂存文件清单:', files.error.message);
    process.exit(1);
  }
  for (const path of files.text.split('\0')) {
    if (path) records.push({ status: 'A', path });
  }
} else {
  const parts = nameStatus.text.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    const path = parts[i++];
    if (/^[RC]/.test(status)) {
      // 重命名/复制只关心新路径
      records.push({ status: status[0], path: parts[i++] });
    } else {
      records.push({ status: status[0], path });
    }
  }
}

// 收集新增行：优先解析 diff（含行号），diff 不可用时按文件读取（无 HEAD 场景）
const addedByFile = new Map(); // path -> [{ line, text }]

let diffText = null;
if (!initialCommit) {
  const diff = git(['diff', '--cached', '-U0', '--no-color']);
  if (!diff.error) diffText = diff.text;
}

if (diffText === null) {
  for (const r of records) {
    if (r.status !== 'A' && r.status !== 'C' && r.status !== 'R') continue;
    try {
      const content = readFileSync(join(projectRoot, r.path), 'utf8');
      addedByFile.set(
        r.path,
        content.split('\n').map((text, i) => ({ line: i + 1, text })),
      );
    } catch {
      // 文件不在磁盘（异常暂存状态），跳过内容扫描
    }
  }
} else {
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
      let list = addedByFile.get(curFile);
      if (!list) {
        list = [];
        addedByFile.set(curFile, list);
      }
      list.push({ line: curLine, text: raw.slice(1) });
      curLine += 1;
    }
    // 其余行（--- / diff / index / Binary / @@ 等）不改变新增行号（-U0 无上下文行）
  }
}

// ---------- 命中判定 ----------

const hits = [];

for (const r of records) {
  if ((r.status === 'A' || r.status === 'C' || r.status === 'R') && isTmpScript(r.path)) {
    hits.push({
      id: 'tmp-script',
      label: 'tmp-* 临时脚本入库',
      file: r.path,
      hint: 'tmp-* 前缀仅用于一次性探索，禁止提交（见 .qoder/rules/tmp-script-governance.md）；请删除或转正为正式脚本',
    });
  }
}

for (const [file, lines] of addedByFile) {
  if (DOC_EXT.has(extOf(file))) continue;
  for (const { line, text } of lines) {
    for (const p of RISK_PATTERNS) {
      if (p.regex.test(text)) {
        hits.push({
          id: p.id,
          label: p.label,
          file,
          line,
          snippet: text.trim().slice(0, 140),
          hint: p.hint,
        });
      }
    }
  }
}

// ---------- 输出与退出 ----------

if (hits.length === 0) {
  console.log('[check-risk-patterns] OK — 暂存变更未命中风险模式。');
  process.exit(0);
}

if (approved) {
  console.warn(
    `[check-risk-patterns] RISK_APPROVED=1 — 已显式审批，放行 ${hits.length} 处风险模式：`,
  );
  for (const h of hits) {
    console.warn(`  - [${h.id}] ${h.file}${h.line ? `:${h.line}` : ''}`);
  }
  process.exit(0);
}

console.error('[check-risk-patterns] FAILED — 暂存变更命中风险模式，需人工评审或显式审批：');
console.error('');
for (const h of hits) {
  console.error(`  ⚠ [${h.id}] ${h.file}${h.line ? `:${h.line}` : ''} — ${h.label}`);
  if (h.snippet) console.error(`      ${h.snippet}`);
  console.error(`      ${h.hint}`);
}
console.error('');
console.error('处置（二选一）：');
console.error('  1. 修改代码消除风险模式后，重新 git add');
console.error('  2. 人工评审确认风险可控后，显式审批放行：RISK_APPROVED=1 git commit');
process.exit(1);
