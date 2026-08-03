#!/usr/bin/env node
/**
 * backfill-missing-tts.mjs
 *
 * 为 data/classrooms 下的存量课堂补齐缺失的预生成音色音频。
 * 每个 speech action 需要 4 种预设音色（PREGENERATED_VOICES）的文件：
 *   data/classrooms/<id>/audio/tts_s<order>_<actionId>_<voiceFile>.mp3
 * 本脚本只生成缺失的文件（不重生成已存在的），并按磁盘实况修正
 * classroom JSON 中的 audioId/audioUrl 字段。
 *
 * 与 POST /api/classroom/[id]/backfill-tts 逻辑等价（该路由用于单课堂），
 * 本脚本用于一次性批量修复全部存量课堂。
 *
 * 用法：
 *   node scripts/backfill-missing-tts.mjs                 # 全量扫描补生成
 *   node scripts/backfill-missing-tts.mjs --dry-run       # 只统计缺失，不调用 API
 *   node scripts/backfill-missing-tts.mjs --classroom=xx  # 只处理指定课堂
 *
 * 环境变量：TTS_MINIMAX_API_KEY / TTS_MINIMAX_BASE_URL（默认读取 .env.local）
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkdir, access, writeFile } from 'fs/promises';

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
const MODEL_ID = 'speech-2.8-hd';
const FORMAT = 'mp3';

// --- 参数 ---
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyClassroom = args.find((a) => a.startsWith('--classroom='))?.split('=')[1];

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

const API_KEY = process.env.TTS_MINIMAX_API_KEY;
const BASE_URL = (process.env.TTS_MINIMAX_BASE_URL || 'https://api.minimaxi.com').replace(
  /\/$/,
  '',
);

if (!API_KEY && !dryRun) {
  console.error('缺少 TTS_MINIMAX_API_KEY（请在 .env.local 中配置）');
  process.exit(1);
}

// --- MiniMax TTS（与 lib/audio/tts-providers.ts generateMiniMaxTTS 一致） ---
async function generateMiniMaxTTS(text, voice, speed) {
  const response = await fetch(`${BASE_URL}/v1/t2a_v2`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
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
  if (!response.ok) {
    throw new Error(`MiniMax TTS API error ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  const hexAudio = data?.data?.audio;
  if (!hexAudio || typeof hexAudio !== 'string') {
    throw new Error(`MiniMax TTS: no audio returned: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const cleaned = hexAudio.trim();
  if (cleaned.length % 2 !== 0) throw new Error('MiniMax TTS: invalid hex payload length');
  const audio = Buffer.from(cleaned, 'hex');
  const format = data?.extra_info?.audio_format || FORMAT;
  return { audio, format };
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
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

// --- 主流程 ---
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
          console.log(`  [ok] ${filename} (${result.audio.length} bytes)`);
        } catch (err) {
          stats.failed += 1;
          console.warn(`  [fail] ${audioId} (voice=${voice}): ${err.message}`);
        }
      }

      const before = JSON.stringify({ audioId: action.audioId, audioUrl: action.audioUrl });
      stampAudioFields(action, baseAudioId, existing, baseUrl, classroomId);
      if (
        JSON.stringify({ audioId: action.audioId, audioUrl: action.audioUrl }) !== before
      ) {
        changed = true;
      }
    }
  }

  if (changed && !dryRun) {
    writeFileSync(join(CLASSROOMS_DIR, `${classroomId}.json`), JSON.stringify(data, null, 2));
  }
  return stats;
}

async function main() {
  const jsonFiles = readdirSync(CLASSROOMS_DIR).filter((f) => f.endsWith('.json'));
  const targets = onlyClassroom
    ? jsonFiles.filter((f) => f === `${onlyClassroom}.json`)
    : jsonFiles;
  if (targets.length === 0) {
    console.error(onlyClassroom ? `未找到课堂 ${onlyClassroom}` : 'data/classrooms 下无课堂 JSON');
    process.exit(1);
  }

  console.log(
    `${dryRun ? '[dry-run] ' : ''}扫描 ${targets.length} 个课堂，预设音色 ${PREGENERATED_VOICES.length} 种\n`,
  );

  const summary = { classrooms: 0, total: 0, missing: 0, generated: 0, failed: 0 };
  for (const file of targets) {
    const classroomId = file.replace(/\.json$/, '');
    let data;
    try {
      data = JSON.parse(readFileSync(join(CLASSROOMS_DIR, file), 'utf-8'));
    } catch {
      console.warn(`跳过 ${classroomId}（JSON 解析失败）`);
      continue;
    }
    const stats = await backfillClassroom(classroomId, data);
    summary.classrooms += 1;
    summary.total += stats.total;
    summary.missing += stats.missing;
    summary.generated += stats.generated;
    summary.failed += stats.failed;
    if (stats.missing > 0) {
      console.log(
        `${classroomId}: ${stats.total} 条语音, 缺失 ${stats.missing}, ` +
          `补生成 ${stats.generated}, 失败 ${stats.failed}`,
      );
    }
  }

  console.log(
    `\n汇总: ${summary.classrooms} 个课堂, ${summary.total} 条语音, ` +
      `缺失 ${summary.missing}, 补生成 ${summary.generated}, 失败 ${summary.failed}`,
  );
  if (dryRun && summary.missing > 0) {
    console.log('（dry-run 模式未生成任何文件，去掉 --dry-run 执行实际补生成）');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
