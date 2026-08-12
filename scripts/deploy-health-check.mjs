#!/usr/bin/env node
/**
 * deploy-health-check.mjs
 *
 * VPS 部署后健康检查 — PM2 状态 + /api/health + classroom-media probe。
 * probe 课堂/音频从本地 data/classrooms/ 动态选取，不硬编码。
 * 注意: 该脚本在 VPS 上运行时（默认 base-url 127.0.0.1:3010）扫描的是 VPS 本地数据；
 *       若在本地对公网探测，可用 --classroom-id 显式指定远端存在的课堂。
 * 用法：node scripts/deploy-health-check.mjs [--base-url=http://localhost:3010/openmaic] [--classroom-id=<id>]
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const BASE_URL = process.env.DEPLOY_BASE_URL ||
  process.argv.find((a) => a.startsWith('--base-url='))?.split('=')[1] ||
  'http://127.0.0.1:3010/openmaic';
const CLASSROOM_ID = process.env.DEPLOY_CLASSROOM_ID ||
  process.argv.find((a) => a.startsWith('--classroom-id='))?.split('=')[1] ||
  null;
// 同机场景（base-url 为本机）时数据目录可直接读取，probe 候选按文件存在性过滤；
// 公网探测时无法预知远端文件，取首候选（404 时给出诊断提示）
const SAME_HOST = /127\.0\.0\.1|localhost/.test(BASE_URL);

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

// 从课堂 JSON 选音频候选；SAME_HOST 时过滤本地不存在的文件，避免选中音频缺失的课堂
function pickAudioId(data, classroomId) {
  for (const scene of data.scenes || []) {
    for (const a of scene.actions || []) {
      if (a.type !== 'speech' || !a.text) continue;
      const candidates = [];
      if (a.audioId) candidates.push(a.audioId);
      for (const v of VOICES) candidates.push(`tts_s${scene.order}_${a.id}_${v}.mp3`);
      if (SAME_HOST) {
        const found = candidates.find((c) =>
          existsSync(join(CLASSROOMS_DIR, classroomId, 'audio', c)),
        );
        if (found) return found;
        continue; // 该 action 无对应音频文件，继续找下一个
      }
      return candidates[0];
    }
  }
  return null;
}

// 从本地 data/classrooms/ 选取 probe 课堂（--classroom-id 显式指定优先，否则动态扫描）
function pickProbe() {
  // 显式指定：直接读取该课堂 JSON，取第一个有可用音频的 speech action
  if (CLASSROOM_ID) {
    try {
      const data = JSON.parse(readFileSync(join(CLASSROOMS_DIR, `${CLASSROOM_ID}.json`), 'utf-8'));
      const audioId = pickAudioId(data, CLASSROOM_ID);
      if (audioId) return { classroom: CLASSROOM_ID, audioId };
      console.error(`  [WARN] 指定课堂 ${CLASSROOM_ID} 无可用 speech 音频`);
    } catch (e) {
      console.error(`  [WARN] 指定课堂 ${CLASSROOM_ID} 读取失败（${e.message}），回退动态扫描`);
    }
  }
  try {
    const files = readdirSync(CLASSROOMS_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const id = file.replace(/\.json$/, '');
      const data = JSON.parse(readFileSync(join(CLASSROOMS_DIR, file), 'utf-8'));
      const name = data.stage?.name || '';
      if (TEST_PATTERNS.some((re) => re.test(name))) continue;
      const audioId = pickAudioId(data, id);
      if (!audioId) continue; // 该课堂无可用音频，跳过
      return { classroom: id, audioId };
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
      // 注意: proxy 的 GET 白名单只放行 GET 方法（HEAD 会被认证拦截返回 401），
      // 因此这里用 GET 并读取首个 chunk 后即取消连接，避免全量下载音频
      const r2 = await fetchTimeout(
        `${BASE_URL}/api/classroom-media/${classroom}/audio/${audioId}`,
        undefined,
        10_000,
      );
      if (r2.body) {
        const reader = r2.body.getReader();
        await reader.read().catch(() => {}); // 读取首个 chunk（~64KB）
        await reader.cancel().catch(() => {}); // 立即取消，不下载完整文件
      }
      if (r2.status === 200 || r2.status === 206) {
        const cl = r2.headers.get('content-length') || '?';
        ok(`HTTP ${r2.status}, Content-Length: ${cl} (${classroom}/${audioId})`);
      } else if (r2.status === 404) {
        fail(`classroom-media 返回 404（${classroom}/${audioId}）。本地课堂与远端数据可能不同步，可用 --classroom-id 指定远端存在的课堂`);
      } else if (r2.status === 401 || r2.status === 403) {
        fail(`classroom-media 返回 ${r2.status}（认证拦截：白名单只放行 GET，若脚本用了 HEAD 请更新）`);
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
