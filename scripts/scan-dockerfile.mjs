#!/usr/bin/env node
// scripts/scan-dockerfile.mjs
//
// Docker 镜像层密钥扫描（阶段 5 T3）。
//
// 背景：Dockerfile 中的 `ENV KEY=value` 会把密钥 bake 进镜像层。
// 即使后续从镜像层 unset，密钥仍然存在于 `docker history <image>` 输出中。
//
// 用法：
//   node scripts/scan-dockerfile.mjs                扫描 ./Dockerfile
//   node scripts/scan-dockerfile.mjs --json        JSON 输出
//   node scripts/scan-dockerfile.mjs Dockerfile.* 多文件
//
// 阻断：命中 ENV KEY/SECRET/TOKEN 行 → exit 1
// 建议：改用 ARG + runtime secret mount（如 Docker Swarm secrets / k8s Secret / Vault）

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const JSON_OUTPUT = args.includes('--json');
const NO_COLOR = process.env.NO_COLOR === '1' || !process.stdout.isTTY;

const C = {
  red: (s) => (NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`),
  yellow: (s) => (NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`),
  green: (s) => (NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`),
  bold: (s) => (NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`),
  dim: (s) => (NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`),
};

const projectRoot = resolve(process.cwd());

// 候选 Dockerfile 列表（如果不传参）
const DEFAULT_FILES = ['Dockerfile', 'Dockerfile.prod', 'Dockerfile.dev', 'docker/Dockerfile'];

const SECRET_KEY_RE = /(?:KEY|TOKEN|SECRET|PASSWORD|PASS|APIKEY|API_KEY|CRED|CREDENTIAL|SESSDATA|COOKIE|PRIVATE)/i;
const ENV_LINE_RE = /^\s*ENV\s+(.+)$/;
const ARG_LINE_RE = /^\s*ARG\s+(.+)$/;

function isPlaceholder(value) {
  const lower = value.toLowerCase();
  // 检查是否包含明确的占位符特征词（独立成词而非子串）
  // 例如 'sk-your-xxx' / 'change-me' / '${VAR}' 视为占位符
  // 但 'abcxxxxxxxxxxxxxxx' 中间的 'xxx' 不视为占位符
  return /\$\{|your-|change-me|replace-|placeholder|^example|sample-|\btodo\b|\bfill-in\b|^<.*>$/.test(lower);
}

function scanContent(file, content) {
  const lines = content.split('\n');
  const hits = [];

  for (let i = 0; i < lines.length; i++) {
    const lineRaw = lines[i];
    const line = lineRaw.replace(/\r$/, '').trim();

    // 跳过注释
    if (line.startsWith('#')) continue;

    // 检查 ENV 行
    const envMatch = line.match(ENV_LINE_RE);
    if (envMatch) {
      const vars = envMatch[1].split(/\s+/);
      for (const v of vars) {
        const eqIdx = v.indexOf('=');
        if (eqIdx === -1) continue;
        const name = v.slice(0, eqIdx);
        const value = v.slice(eqIdx + 1);

        if (SECRET_KEY_RE.test(name) && !isPlaceholder(value)) {
          hits.push({
            type: 'ENV',
            name,
            line: i + 1,
            snippet: lineRaw.trim().slice(0, 120),
            severity: 'high',
            hint: '改用 ARG + runtime secret mount（Docker Swarm secrets / k8s Secret / Vault）',
          });
        }
      }
      continue;
    }

    // 检查 ARG 行（同样有风险，build-time 注入可能被镜像缓存）
    const argMatch = line.match(ARG_LINE_RE);
    if (argMatch) {
      const vars = argMatch[1].split(/\s+/);
      for (const v of vars) {
        const eqIdx = v.indexOf('=');
        if (eqIdx === -1) continue;
        const name = v.slice(0, eqIdx);
        const value = v.slice(eqIdx + 1);
        if (SECRET_KEY_RE.test(name) && !isPlaceholder(value) && value.length >= 16) {
          hits.push({
            type: 'ARG',
            name,
            line: i + 1,
            snippet: lineRaw.trim().slice(0, 120),
            severity: 'medium',
            hint: 'ARG 默认值会嵌入镜像 metadata，建议改用 build-time secret file 或外部 CI secret',
          });
        }
      }
    }
  }

  return hits.map((h) => ({ file, ...h }));
}

function main() {
  let files = args.filter((a) => !a.startsWith('--'));
  if (files.length === 0) {
    files = DEFAULT_FILES;
  }

  const results = [];
  for (const f of files) {
    const filePath = resolve(projectRoot, f);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, 'utf8');
    results.push(...scanContent(f, content));
  }

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({ ok: results.length === 0, hits: results }, null, 2));
  } else {
    if (results.length === 0) {
      console.log(C.green('[scan-dockerfile] OK — 未发现 Docker 镜像层密钥风险'));
    } else {
      console.log(C.red(`[scan-dockerfile] FAILED — 发现 ${results.length} 处风险：`));
      console.log('');
      for (const h of results) {
        console.log(C.yellow(`  [${h.severity}] ${h.file}:${h.line}  ${h.type} ${h.name}`));
        console.log(C.dim(`    内容: ${h.snippet}`));
        console.log(C.dim(`    建议: ${h.hint}`));
        console.log('');
      }
      console.log(C.yellow('修复建议：'));
      console.log('  - ENV KEY=VALUE：改为 ARG KEY（build-time secret）+ 运行时 mount');
      console.log('  - 使用 Docker Swarm secrets / k8s Secret / HashiCorp Vault');
      console.log('  - 或使用 buildx --secret id=KEY,src=./secrets.txt');
    }
  }

  process.exit(results.length === 0 ? 0 : 1);
}

main();