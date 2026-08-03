#!/usr/bin/env node
/**
 * backfill-missing-tts.mjs
 *
 * 为 data/classrooms 下的存量课堂补齐缺失的预生成音色音频。
 * 每个 speech action 需要 4 种预设音色（PREGENERATED_VOICES）的文件：
 *   data/classrooms/<id>/audio/tts_s<order>_<actionId>_<voiceFile>.mp3
 * 本脚本只生成缺失的文件（不重生成已存在的，幂等可断点续跑），并按磁盘
 * 实况修正 classroom JSON 中的 audioId/audioUrl 字段。
 *
 * 与 POST /api/classroom/[id]/backfill-tts 逻辑等价（该路由用于单课堂），
 * 本脚本用于一次性批量修复全部存量课堂。
 *
 * 限流策略（AIMD 自适应）：
 *   - 起始 BACKFILL_RPM（默认 20），60s 窗口内无 1002 限流 → RPM +5
 *     （上限 BACKFILL_MAX_RPM，默认 60）
 *   - 出现 1002/429 → RPM 减半（下限 8）+ 60s 冷却，重试退避 30/60/120s
 *   - TTS_MINIMAX_API_KEY 支持逗号分隔多 Key，逐请求轮询
 *
 * 熔断策略：连续 BACKFILL_BALANCE_FAIL_LIMIT（默认 20）次余额不足
 * （MiniMax status_code 1008）即终止运行，避免无余额时无效空转。
 *
 * 用法：
 *   node scripts/backfill-missing-tts.mjs                 # 全量补生成
 *   node scripts/backfill-missing-tts.mjs --dry-run       # 只统计缺失，不调用 API
 *   node scripts/backfill-missing-tts.mjs --classroom=xx  # 只处理指定课堂
 *   node scripts/backfill-missing-tts.mjs --priority      # 已绑定课程优先 + 缺失少优先
 *   node scripts/backfill-missing-tts.mjs --window=18-9   # 仅 18:00 至次日 9:00 运行
 *   node scripts/backfill-missing-tts.mjs --include-tests # 不跳过测试课堂
 *
 * 进度：每完成一个课堂写入 data/backfill-progress.json（可中断续跑）。
 * 环境变量：TTS_MINIMAX_API_KEY / TTS_MINIMAX_BASE_URL / DATABASE_URL（默认读取 .env.local）
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkdir, access, writeFile } from 'fs/promises';
import { createRequire } from 'module';

// --- 与 lib/audio/constants.ts 保持一致 ---
const PREGENERATED_VOICES = [
  'female-yujie',
  'female-shaonv',
  'male-qn-jingying',
  'Chinese (Mandarin)_Gentleman',
];
const DEFAULT_PREGENERATED_VOICE = 'female-yujie';
const voiceIdToFileName = (voiceId) => voiceId.replace(/[^a-zA-Z0-9_-]/g, '_');

const ROOT = join(import.meta.dirname, '..');
const CLASSROOMS_DIR = join(ROOT, 'data', 'classrooms');
const PROGRESS_FILE = join(ROOT, 'data', 'backfill-progress.json');
const MODEL_ID = 'speech-2.8-hd';
const FORMAT = 'mp3';
const TEST_CLASSROOM_PATTERNS = [/test connectivity/i, /precheck/i];

// --- 参数 ---
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const priority = args.includes('--priority');
const includeTests = args.includes('--include-tests');
const onlyClassroom = args.find((a) => a.startsWith('--classroom='))?.split('=')[1];
const windowArg = args.find((a) => a.startsWith('--window='))?.split('=')[1];

// --- 环境变量（.env.local 简易解析） ---
function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2];
    }
  }
}
loadEnvFile(join(ROOT, '.env.local'));

// 多 Key 轮询：逗号分隔（与服务端 resolveKey 行为一致）
const API_KEYS = (process.env.TTS_MINIMAX_API_KEY || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);
const BASE_URL = (process.env.TTS_MINIMAX_BASE_URL || 'https://api.minimaxi.com').replace(
  /\/$/,
  '',
);

if (API_KEYS.length === 0 && !dryRun) {
  console.error('缺少 TTS_MINIMAX_API_KEY（请在 .env.local 中配置）');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- AIMD 自适应限速器 ---
// 加性增（60s 窗口无 1002 → +5 RPM）、乘性减（1002 → 减半 + 60s 冷却）。
const START_RPM = Number(process.env.BACKFILL_RPM || 20);
const MAX_RPM = Number(process.env.BACKFILL_MAX_RPM || 60);
const MIN_RPM = 8;
const WINDOW_MS = 60_000;

const limiter = {
  rpm: START_RPM,
  lastRequestAt: 0,
  lastRateLimitedAt: 0,
  lastIncreaseAt: 0,
  cooldownUntil: 0,

  get intervalMs() {
    return Math.ceil(60_000 / this.rpm);
  },

  async waitTurn() {
    const now = Date.now();
    if (now < this.cooldownUntil) {
      await sleep(this.cooldownUntil - now);
    }
    const wait = this.lastRequestAt + this.intervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  },

  onSuccess() {
    const now = Date.now();
    if (
      now - this.lastRateLimitedAt > WINDOW_MS &&
      now - this.lastIncreaseAt > WINDOW_MS &&
      this.rpm < MAX_RPM
    ) {
      this.rpm = Math.min(MAX_RPM, this.rpm + 5);
      this.lastIncreaseAt = now;
      console.log(`  [aimd] 窗口内无限流，提速至 ${this.rpm} RPM`);
    }
  },

  onRateLimited() {
    const before = this.rpm;
    this.rpm = Math.max(MIN_RPM, Math.floor(this.rpm / 2));
    this.lastRateLimitedAt = Date.now();
    this.cooldownUntil = Date.now() + WINDOW_MS;
    console.warn(`  [aimd] 触发限流，RPM ${before} → ${this.rpm}，冷却 60s`);
  },
};

let keyIndex = 0;
function nextApiKey() {
  const key = API_KEYS[keyIndex % API_KEYS.length];
  keyIndex += 1;
  return key;
}

const RATE_LIMIT_RETRIES = 3;

// --- 额度类错误熔断：连续 N 次即终止，避免无效空转 ---
// 1008 = 余额不足；2056 = Token Plan 用量上限（实测确认，曾空转 358 次）；
// 消息关键词兜底覆盖其他额度类错误。
const QUOTA_ERROR_CODES = new Set([1008, 2056]);
const QUOTA_MSG_PATTERNS = [/用量上限/, /余额不足/, /insufficient balance/, /Token Plan/i];
const QUOTA_FAIL_LIMIT = Number(process.env.BACKFILL_BALANCE_FAIL_LIMIT || 20);
let consecutiveQuotaFailures = 0;

function isQuotaError(err) {
  return (
    QUOTA_ERROR_CODES.has(err.code) || QUOTA_MSG_PATTERNS.some((re) => re.test(err.message))
  );
}

// --- MiniMax TTS（与 lib/audio/tts-providers.ts generateMiniMaxTTS 一致） ---
async function generateMiniMaxTTS(text, voice, speed) {
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
    await limiter.waitTurn();
    let response;
    try {
      response = await fetch(`${BASE_URL}/v1/t2a_v2`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${nextApiKey()}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          model: MODEL_ID,
          text,
          stream: false,
          output_format: 'hex',
          voice_setting: { voice_id: voice, speed: speed || 1.0, vol: 1, pitch: 0 },
          audio_setting: { sample_rate: 32000, bitrate: 128000, format: FORMAT, channel: 1 },
          language_boost: 'auto',
        }),
      });
    } catch (err) {
      // 网络错误：短暂退避后重试
      if (attempt < RATE_LIMIT_RETRIES) {
        const backoff = 30_000 * 2 ** attempt;
        console.warn(`  [network] ${err.message}，${backoff / 1000}s 后重试`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }

    if (response.status === 429) {
      limiter.onRateLimited();
      if (attempt < RATE_LIMIT_RETRIES) {
        const backoff = 30_000 * 2 ** attempt;
        await sleep(backoff);
        continue;
      }
      throw new Error('MiniMax TTS: HTTP 429 rate limit after retries');
    }
    if (!response.ok) {
      throw new Error(`MiniMax TTS API error ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    // 业务限流（status_code 1002）：降速 + 退避重试
    if (data?.base_resp?.status_code === 1002) {
      limiter.onRateLimited();
      if (attempt < RATE_LIMIT_RETRIES) {
        const backoff = 30_000 * 2 ** attempt;
        console.warn(
          `  [rate-limited] 退避 ${backoff / 1000}s 后重试 (${attempt + 1}/${RATE_LIMIT_RETRIES})`,
        );
        await sleep(backoff);
        continue;
      }
      throw new Error('MiniMax TTS: rate limit exceeded after retries');
    }
    if (data?.base_resp?.status_code && data.base_resp.status_code !== 0) {
      const err = new Error(
        `MiniMax TTS error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`,
      );
      err.code = data.base_resp.status_code;
      throw err;
    }

    const hexAudio = data?.data?.audio;
    if (!hexAudio || typeof hexAudio !== 'string') {
      throw new Error(`MiniMax TTS: no audio returned: ${JSON.stringify(data).slice(0, 300)}`);
    }
    const cleaned = hexAudio.trim();
    if (cleaned.length % 2 !== 0) throw new Error('MiniMax TTS: invalid hex payload length');
    const audio = Buffer.from(cleaned, 'hex');
    const format = data?.extra_info?.audio_format || FORMAT;
    limiter.onSuccess();
    return { audio, format };
  }
  throw new Error('MiniMax TTS: exhausted retries');
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// --- 快速预扫描：统计课堂缺失文件数（用于排序，不发请求） ---
function countMissing(data) {
  const classroomId = data.id;
  const audioDir = join(CLASSROOMS_DIR, classroomId, 'audio');
  let missing = 0;
  for (const scene of data.scenes || []) {
    for (const action of scene.actions || []) {
      if (action.type !== 'speech' || !action.text) continue;
      for (const voice of PREGENERATED_VOICES) {
        const f = join(
          audioDir,
          `tts_s${scene.order}_${action.id}_${voiceIdToFileName(voice)}.${FORMAT}`,
        );
        if (!existsSync(f)) missing += 1;
      }
    }
  }
  return missing;
}

// --- audioId/audioUrl 写入（与 stampAudioFields 一致） ---
function mediaServingUrl(baseUrl, classroomId, subPath) {
  return `${baseUrl}/api/classroom-media/${classroomId}/${subPath}`;
}

function stampAudioFields(action, baseAudioId, existingVoiceFiles, baseUrl, classroomId) {
  if (existingVoiceFiles.length === 0) return;
  const defaultVoiceFile = voiceIdToFileName(DEFAULT_PREGENERATED_VOICE);
  const anchor = existingVoiceFiles.includes(defaultVoiceFile)
    ? defaultVoiceFile
    : existingVoiceFiles[0];
  action.audioId = `${baseAudioId}_${anchor}`;
  action.audioUrl = existingVoiceFiles.includes(defaultVoiceFile)
    ? mediaServingUrl(baseUrl, classroomId, `audio/${baseAudioId}_{voice}.${FORMAT}`)
    : mediaServingUrl(baseUrl, classroomId, `audio/${baseAudioId}_${anchor}.${FORMAT}`);
}

// --- baseUrl：与 buildRequestOrigin 一致（basePath 优先） ---
const baseUrl = process.env.NEXT_PUBLIC_BASE_PATH || 'http://localhost:3010';

// --- 进度文件 ---
function loadProgress() {
  try {
    return JSON.parse(readFileSync(PROGRESS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function saveProgress(progress) {
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// --- 优先级：查询 Philochora courses 表已绑定的课堂 ID ---
async function fetchBoundClassroomIds() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;
  try {
    const require = createRequire(import.meta.url);
    const { Client } = require('pg');
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    const res = await client.query(
      'SELECT classroom_id FROM courses WHERE classroom_id IS NOT NULL',
    );
    await client.end();
    return new Set(res.rows.map((r) => r.classroom_id));
  } catch (err) {
    console.warn(`[priority] 数据库查询失败（${err.message}），降级为缺失数排序`);
    return null;
  }
}

// --- 时段调度：--window=18-9 表示仅 18:00 至次日 09:00 运行 ---
function parseWindow(spec) {
  if (!spec) return null;
  const m = spec.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) {
    console.error(`无效的 --window 格式：${spec}（应为 START-END，如 18-9）`);
    process.exit(1);
  }
  return { start: Number(m[1]), end: Number(m[2]) };
}

function inWindow(win) {
  if (!win) return true;
  const h = new Date().getHours();
  return win.start < win.end ? h >= win.start && h < win.end : h >= win.start || h < win.end;
}

async function waitForWindow(win) {
  if (!win || dryRun) return;
  while (!inWindow(win)) {
    const now = new Date();
    console.log(
      `[window] 当前 ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')} 不在运行窗口 ` +
        `${win.start}:00-${win.end}:00 内，60s 后重查…`,
    );
    await sleep(60_000);
  }
}

// --- 单课堂补生成 ---
async function backfillClassroom(classroomId, data) {
  const audioDir = join(CLASSROOMS_DIR, classroomId, 'audio');
  const stats = { total: 0, missing: 0, generated: 0, failed: 0 };
  let changed = false;

  for (const scene of data.scenes || []) {
    if (!scene.actions) continue;
    for (const action of scene.actions) {
      if (action.type !== 'speech' || !action.text) continue;
      const baseAudioId = `tts_s${scene.order}_${action.id}`;
      stats.total += 1;

      const existing = [];
      for (const voice of PREGENERATED_VOICES) {
        const voiceFile = voiceIdToFileName(voice);
        const audioId = `${baseAudioId}_${voiceFile}`;
        if (await fileExists(join(audioDir, `${audioId}.${FORMAT}`))) {
          existing.push(voiceFile);
          continue;
        }
        stats.missing += 1;
        if (dryRun) continue;
        try {
          const result = await generateMiniMaxTTS(action.text, voice, action.speed);
          await mkdir(audioDir, { recursive: true });
          const filename = `${audioId}.${result.format || FORMAT}`;
          await writeFile(join(audioDir, filename), result.audio);
          existing.push(voiceFile);
          stats.generated += 1;
          consecutiveQuotaFailures = 0;
        } catch (err) {
          stats.failed += 1;
          console.warn(`  [fail] ${audioId} (voice=${voice}): ${err.message}`);
          if (isQuotaError(err)) {
            consecutiveQuotaFailures += 1;
            if (consecutiveQuotaFailures >= QUOTA_FAIL_LIMIT) {
              throw new Error(
                `[circuit-breaker] 连续 ${consecutiveQuotaFailures} 次额度错误` +
                  `（余额不足/Token Plan 用量上限），终止运行。` +
                  `恢复额度后重跑本脚本即可断点续补。`,
              );
            }
            if (consecutiveQuotaFailures === 1) {
              console.warn(
                `  [circuit-breaker] 检测到额度错误，连续 ${QUOTA_FAIL_LIMIT} 次后将自动终止`,
              );
            }
          } else {
            consecutiveQuotaFailures = 0;
          }
        }
      }

      const before = JSON.stringify({ audioId: action.audioId, audioUrl: action.audioUrl });
      stampAudioFields(action, baseAudioId, existing, baseUrl, classroomId);
      if (JSON.stringify({ audioId: action.audioId, audioUrl: action.audioUrl }) !== before) {
        changed = true;
      }
    }
  }

  if (changed && !dryRun) {
    writeFileSync(join(CLASSROOMS_DIR, `${classroomId}.json`), JSON.stringify(data, null, 2));
  }
  return stats;
}

// --- 主流程 ---
async function main() {
  const win = parseWindow(windowArg);
  const jsonFiles = readdirSync(CLASSROOMS_DIR).filter((f) => f.endsWith('.json'));

  // 加载并预扫描全部课堂
  const classrooms = [];
  for (const file of jsonFiles) {
    const id = file.replace(/\.json$/, '');
    if (onlyClassroom && id !== onlyClassroom) continue;
    let data;
    try {
      data = JSON.parse(readFileSync(join(CLASSROOMS_DIR, file), 'utf-8'));
    } catch {
      console.warn(`跳过 ${id}（JSON 解析失败）`);
      continue;
    }
    const name = data.stage?.name || '';
    const isTest = TEST_CLASSROOM_PATTERNS.some((re) => re.test(name));
    if (isTest && !includeTests && !onlyClassroom) {
      console.log(`跳过测试课堂 ${id}（${name}）`);
      continue;
    }
    const missing = countMissing(data);
    classrooms.push({ id, data, name, missing });
  }

  if (classrooms.length === 0) {
    console.error(onlyClassroom ? `未找到课堂 ${onlyClassroom}` : 'data/classrooms 下无课堂 JSON');
    process.exit(1);
  }

  // 排序：--priority 时已绑定课程的课堂优先；其余按缺失数升序（先易后难）
  const boundIds = priority ? await fetchBoundClassroomIds() : null;
  classrooms.sort((a, b) => {
    if (boundIds) {
      const ab = boundIds.has(a.id) ? 0 : 1;
      const bb = boundIds.has(b.id) ? 0 : 1;
      if (ab !== bb) return ab - bb;
    }
    return a.missing - b.missing;
  });

  const targets = classrooms.filter((c) => c.missing > 0);
  const totalMissing = targets.reduce((s, c) => s + c.missing, 0);
  console.log(
    `${dryRun ? '[dry-run] ' : ''}扫描 ${classrooms.length} 个课堂，` +
      `${targets.length} 个有缺失（共 ${totalMissing} 个文件），` +
      `预设音色 ${PREGENERATED_VOICES.length} 种，` +
      `API Key ${API_KEYS.length} 个，起始 ${limiter.rpm} RPM（上限 ${MAX_RPM}）` +
      (win ? `，运行窗口 ${win.start}:00-${win.end}:00` : '') +
      '\n',
  );

  const prev = loadProgress();
  const summary =
    prev && !dryRun && !onlyClassroom
      ? { ...prev.totals }
      : { classrooms: 0, missing: 0, generated: 0, failed: 0 };

  for (const { id, data, name, missing } of targets) {
    await waitForWindow(win);
    const stats = await backfillClassroom(id, data);
    summary.classrooms += 1;
    summary.missing += stats.missing;
    summary.generated += stats.generated;
    summary.failed += stats.failed;
    console.log(
      `[${summary.classrooms}/${targets.length}] ${id}（${name}）: 缺失 ${stats.missing}, ` +
        `补生成 ${stats.generated}, 失败 ${stats.failed} | 累计补生成 ${summary.generated}`,
    );
    if (!dryRun) {
      saveProgress({
        startedAt: prev?.startedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        classroomsDone: summary.classrooms,
        lastClassroomId: id,
        currentRpm: limiter.rpm,
        totals: summary,
      });
    }
  }

  console.log(
    `\n汇总: ${summary.classrooms} 个课堂, 缺失 ${summary.missing}, ` +
      `补生成 ${summary.generated}, 失败 ${summary.failed}, 最终 RPM ${limiter.rpm}`,
  );
  if (dryRun && summary.missing > 0) {
    console.log('（dry-run 模式未生成任何文件，去掉 --dry-run 执行实际补生成）');
  }
  if (summary.failed > 0) {
    console.log('存在失败项：可重跑本命令续补（幂等），或用 --classroom=<id> 单独重试');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
