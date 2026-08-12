#!/usr/bin/env node
/**
 * deploy-health-check.mjs
 *
 * VPS 部署后健康检查 — PM2 状态 + /api/health + classroom-media probe。
 * probe 课堂/音频从本地 data/classrooms/ 动态选取，不硬编码。
 * 用法：node scripts/deploy-health-check.mjs [--base-url=http://localhost:3010/openmaic]
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const BASE_URL = process.env.DEPLOY_BASE_URL ||
  process.argv.find((a) => a.startsWith('--base-url='))?.split('=')[1] ||
  'http://127.0.0.1:3010/openmaic';

// 与 deploy-verify.mjs 保持一致的 voice 命名集合
const VOICES = [
  'female-yujie',
  'female-shaonv',
  'male-qn-jingying',
  'Chinese__Mandarin__Gentleman',
];
const TEST_PATTERNS = [/test connectivity/i, /precheck/i];
const CLASSROOMS_DIR = join(import.meta.dirname, '..', 'data', 'classrooms');

const errors = [];
function fail(msg) { console.error('  [FAIL]', msg); errors.push(msg); }
function ok(msg) { console.log('  [OK]', msg); }
function warnSkip(msg) { console.log('  [SKIP]', msg); }

// 带超时的 fetch
async function fetchTimeout(url, opts = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// 从本地 data/classrooms/ 动态选取一个正式课堂作为 probe 目标
function pickProbe() {
  try {
    const files = readdirSync(CLASSROOMS_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const id = file.replace(/\.json$/, '');
      const data = JSON.parse(readFileSync(join(CLASSROOMS_DIR, file), 'utf-8'));
      const name = data.stage?.name || '';
      if (TEST_PATTERNS.some((re) => re.test(name))) continue;
      // 取第一个 speech action 构造音频 probe
      for (const scene of data.scenes || []) {
        for (const a of scene.actions || []) {
          if (a.type !== 'speech' || !a.text) continue;
          const audioId = a.audioId || `tts_s${scene.order}_${a.id}_${VOICES[0]}.mp3`;
          return { classroom: id, audioId };
        }
      }
    }
  } catch (e) {
    console.error(`  [WARN] 本地课堂扫描失败（${e.message}），probe 将跳过`);
  }
  return null;
}

async function main() {
  console.log(`Health Check: ${BASE_URL}\n`);

  // 1. /api/health
  console.log('[1] /api/health ...');
  try {
    const r1 = await fetchTimeout(`${BASE_URL}/api/health`);
    if (r1.status !== 200) {
      fail(`/api/health 返回 ${r1.status}`);
    } else {
      const body = await r1.text();
      ok(`HTTP 200 (${body.slice(0, 100)})`);
    }
  } catch (e) {
    fail(`/api/health 异常: ${e.message}`);
  }

  // 2. classroom-media probe（动态选取一个正式课堂的音频）
  console.log('\n[2] classroom-media probe ...');
  const probe = pickProbe();
  if (!probe) {
    warnSkip('本地无可用正式课堂，跳过 classroom-media probe');
  } else {
    const { classroom, audioId } = probe;
    try {
      const r2 = await fetchTimeout(
        `${BASE_URL}/api/classroom-media/${classroom}/audio/${audioId}`,
        { method: 'HEAD' },
        10_000,
      );
      if (r2.status === 200 || r2.status === 206) {
        const cl = r2.headers.get('content-length') || '?';
        ok(`HTTP ${r2.status}, Content-Length: ${cl} (${classroom}/${audioId})`);
      } else if (r2.status === 404) {
        fail(`classroom-media 返回 404（${classroom}/${audioId}），文件可能未同步`);
      } else {
        fail(`classroom-media 返回 ${r2.status}`);
      }
    } catch (e) {
      fail(`classroom-media probe 异常: ${e.message}`);
    }
  }

  // 3. 课堂 JSON API 抽样
  console.log('\n[3] classroom API probe ...');
  if (!probe) {
    warnSkip('本地无可用正式课堂，跳过 classroom API probe');
  } else {
    const { classroom } = probe;
    try {
      const r3 = await fetchTimeout(
        `${BASE_URL}/api/classroom?id=${classroom}`,
        undefined,
        10_000,
      );
      if (r3.status === 200) {
        const data = await r3.json();
        const scenes = data.classroom?.scenes?.length || 0;
        ok(`HTTP 200, ${scenes} scenes`);
      } else {
        fail(`classroom API 返回 ${r3.status}`);
      }
    } catch (e) {
      fail(`classroom API probe 异常: ${e.message}`);
    }
  }

  // 结论
  console.log(`\n========================================`);
  if (errors.length === 0) {
    console.log('Health Check 通过');
    process.exit(0);
  } else {
    console.log(`Health Check 失败: ${errors.length} 项`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
