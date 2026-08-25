#!/usr/bin/env node
/**
 * check-api-surface.mjs
 *
 * API 面契约静态校验（ADR-0001）：
 *   app/api/** 的每一个路由都必须在 deploy/nginx/philochora.conf 中显式落位——
 *   要么命中白名单（proxy_pass），要么命中显式黑名单（return 403）。
 *   落入「/openmaic/ 兜底 403」而未被任何显式规则覆盖的路由视为契约违规：
 *   这意味着"忘记配 nginx"，历史上正是这类遗漏导致托管模式课堂讨论静默失效。
 *
 * 用法：
 *   node scripts/check-api-surface.mjs           # 阻断模式（违规 → exit 1）
 *   node scripts/check-api-surface.mjs --warn    # 对账模式（只输出清单，不阻断）
 *
 * 逃生口：在 .githooks/pre-push 中以 SKIP_API_SURFACE_CHECK=1 跳过。
 *
 * 判定说明：路由路径中的动态段（[id]、[...path]）以占位符参与匹配——
 * nginx 规则只关心路径形状与前缀，占位符不影响判定正确性。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..');
const API_DIR = join(ROOT, 'app', 'api');
const CONF_PATH = join(ROOT, 'deploy', 'nginx', 'philochora.conf');

const WARN_ONLY = process.argv.includes('--warn');

// ---------- 1. 枚举 app/api/** 全部路由 ----------

/** 递归收集 route.ts，转换为 /openmaic/api/... 形式的路径（与 nginx 规则同基准） */
function enumerateRoutes(dir, routes = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      enumerateRoutes(full, routes);
    } else if (entry === 'route.ts') {
      routes.push(full);
    }
  }
  return routes;
}

/** app/api/foo/[id]/bar/route.ts → /openmaic/api/foo/x/bar（动态段以占位符参与匹配） */
function routeToPath(file) {
  const rel = file.slice(API_DIR.length + 1); // foo/[id]/bar/route.ts
  const segments = rel.split(/[\\/]/).slice(0, -1); // 去掉 route.ts
  const mapped = segments.map((seg) => {
    if (seg.startsWith('[...') || seg.startsWith('[[...')) return 'x'; // catch-all
    if (seg.startsWith('[')) return 'x'; // 动态段
    return seg;
  });
  return '/openmaic/api/' + mapped.join('/');
}

// ---------- 2. 解析 nginx 配置中的显式规则 ----------

/**
 * 提取形如 `location ~* ^/openmaic/(...) {` 的正则规则，按出现顺序返回
 * （nginx 对 regex location 按出现顺序匹配，首中即止）。
 * kind 由块体内首个指令判定：proxy_pass → allow；return 403 → deny。
 */
function parseConfRules(confText) {
  const lines = confText.split('\n');
  const rules = [];
  const locationRe = /^\s*location\s+~\*?\s+(\^\/openmaic\/.*?)\s*\{/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(locationRe);
    if (!m) continue;
    // 向后找块体内首个语义指令
    let kind = 'unknown';
    for (let j = i + 1; j < lines.length && !lines[j].includes('location'); j++) {
      const t = lines[j].trim();
      if (t.startsWith('#') || t === '') continue;
      if (t.startsWith('proxy_pass')) kind = 'allow';
      else if (/^return\s+40[0-9]/.test(t)) kind = 'deny';
      break;
    }
    let re;
    try {
      re = new RegExp(m[1], 'i');
    } catch (e) {
      console.error(`[check-api-surface] 无法解析 nginx 正则: ${m[1]} (${e.message})`);
      process.exit(1);
    }
    rules.push({ pattern: m[1], re, kind, line: i + 1 });
  }
  return rules;
}

// ---------- 3. 分类与报告 ----------

function main() {
  if (!existsSync(CONF_PATH)) {
    console.error(`[check-api-surface] 契约文件不存在: ${CONF_PATH}`);
    process.exit(1);
  }
  const rules = parseConfRules(readFileSync(CONF_PATH, 'utf-8'));
  if (rules.length === 0) {
    console.error('[check-api-surface] 未从契约文件解析到任何 /openmaic/ 正则规则');
    process.exit(1);
  }

  const routeFiles = enumerateRoutes(API_DIR);
  const allowed = [];
  const denied = [];
  const violations = []; // 落入兜底 403，未显式落位

  for (const file of routeFiles) {
    const path = routeToPath(file);
    const hit = rules.find((r) => r.re.test(path));
    if (!hit) {
      violations.push(path);
    } else if (hit.kind === 'allow') {
      allowed.push(path);
    } else {
      denied.push({ path, pattern: hit.pattern });
    }
  }

  console.log(`[check-api-surface] 路由 ${routeFiles.length} 条 × 规则 ${rules.length} 条（${WARN_ONLY ? '对账模式' : '阻断模式'}）`);
  console.log(`  ✓ 白名单放行: ${allowed.length}`);
  console.log(`  ⊘ 显式黑名单拒绝: ${denied.length}`);
  for (const d of denied) console.log(`      ${d.path}  ← ${d.pattern}`);

  // 兜底规则匹配不到任何路由 → 提示可能的陈旧规则
  for (const r of rules) {
    const anyMatch = routeFiles.some((f) => r.re.test(routeToPath(f)));
    if (!anyMatch) console.log(`  ⚠ 规则未匹配任何路由（可能陈旧）: L${r.line} ${r.pattern}`);
  }

  if (violations.length > 0) {
    console.error(`\n[check-api-surface] ⛔ ${violations.length} 条路由未在契约中显式落位：`);
    for (const v of violations) console.error(`    ${v}`);
    console.error(
      '\n这些路径会被 /openmaic/ 兜底规则静默拦截（403），历史上同类遗漏曾导致托管模式课堂讨论失效（ADR-0001）。\n' +
        `请在 ${CONF_PATH} 中将其加入白名单或显式黑名单，再推送。\n` +
        '紧急逃生口: SKIP_API_SURFACE_CHECK=1 git push',
    );
    process.exit(WARN_ONLY ? 0 : 1);
  }

  console.log('[check-api-surface] ✓ API 面契约完整：所有路由均已显式落位。');
  process.exit(0);
}

main();
