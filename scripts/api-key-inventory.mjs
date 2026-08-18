#!/usr/bin/env node
// scripts/api-key-inventory.mjs
//
// 扫描 .env* 和 server-providers*.yml，输出 inventory（不含 value，仅 fingerprint）。
// 用于：[key-owners-roster.md](../docs/security/key-owners-roster.md) 维护 + 轮换 SOP。
//
// Usage:
//   node scripts/api-key-inventory.mjs               扫描当前目录
//   node scripts/api-key-inventory.mjs --json       JSON 输出（机器可读）
//   node scripts/api-key-inventory.mjs --md         Markdown 表格输出（直接贴 roster）
//
// Exit 0: 扫描成功
// Exit 1: 至少一个 .env* 文件读取失败

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';

const args = process.argv.slice(2);
const JSON_OUTPUT = args.includes('--json');
const MD_OUTPUT = args.includes('--md');
const NO_COLOR = process.env.NO_COLOR === '1' || !process.stdout.isTTY;

const C = {
  green: (s) => (NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`),
  yellow: (s) => (NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`),
  red: (s) => (NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`),
  dim: (s) => (NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`),
};

const projectRoot = resolve(process.cwd());

// 候选扫描文件
const TARGET_FILES = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.production.local',
  '.env.secrets',
  '.env.secrets.staging',
  '.env.tunnel',
  '.env.vps.local',
  'server-providers.yml',
  'server-providers.local.yml',
];

// 已知 provider 前缀（基于 OpenMAIC .env.example + Philochora .env.example）
const PROVIDER_PATTERNS = [
  { name: 'openai', envKey: /^OPENAI_API_KEY=/ },
  { name: 'azure-openai', envKey: /^AZURE_OPENAI_API_KEY=/ },
  { name: 'atlascloud', envKey: /^ATLASCLOUD_API_KEY=/ },
  { name: 'anthropic', envKey: /^ANTHROPIC_API_KEY=/ },
  { name: 'google', envKey: /^GOOGLE_API_KEY=/ },
  { name: 'deepseek', envKey: /^DEEPSEEK_API_KEY(=|_FALLBACK|=.*)/ },
  { name: 'qwen', envKey: /^QWEN_API_KEY=/ },
  { name: 'kimi', envKey: /^KIMI_API_KEY=/ },
  { name: 'minimax', envKey: /^MINIMAX_API_KEY=/ },
  { name: 'minimax-tts', envKey: /^TTS_MINIMAX_API_KEY=/ },
  { name: 'minimax-image', envKey: /^IMAGE_MINIMAX_API_KEY=/ },
  { name: 'minimax-video', envKey: /^VIDEO_MINIMAX_API_KEY=/ },
  { name: 'minimax-websearch', envKey: /^WEB_SEARCH_MINIMAX_API_KEY=/ },
  { name: 'glm', envKey: /^GLM_API_KEY=/ },
  { name: 'siliconflow', envKey: /^SILICONFLOW_API_KEY=/ },
  { name: 'doubao', envKey: /^DOUBAO_API_KEY=/ },
  { name: 'openrouter', envKey: /^OPENROUTER_API_KEY=/ },
  { name: 'grok', envKey: /^GROK_API_KEY=/ },
  { name: 'tencent', envKey: /^TENCENT_API_KEY=/ },
  { name: 'xiaomi', envKey: /^XIAOMI_API_KEY=/ },
  { name: 'ollama', envKey: /^OLLAMA_API_KEY=/ },
  { name: 'lemonade', envKey: /^LEMONADE_API_KEY=/ },
  { name: 'tts-openai', envKey: /^TTS_OPENAI_API_KEY=/ },
  { name: 'tts-azure', envKey: /^TTS_AZURE_API_KEY=/ },
  { name: 'tts-glm', envKey: /^TTS_GLM_API_KEY=/ },
  { name: 'tts-qwen', envKey: /^TTS_QWEN_API_KEY=/ },
  { name: 'tts-doubao', envKey: /^TTS_DOUBAO_API_KEY=/ },
  { name: 'tts-voxcpm', envKey: /^TTS_VOXCPM_API_KEY=/ },
  { name: 'tts-elevenlabs', envKey: /^TTS_ELEVENLABS_API_KEY=/ },
  { name: 'tts-lemonade', envKey: /^TTS_LEMONADE_API_KEY=/ },
  { name: 'asr-openai', envKey: /^ASR_OPENAI_API_KEY=/ },
  { name: 'asr-qwen', envKey: /^ASR_QWEN_API_KEY=/ },
  { name: 'asr-azure', envKey: /^ASR_AZURE_API_KEY=/ },
  { name: 'pdf-unpdf', envKey: /^PDF_UNPDF_API_KEY=/ },
  { name: 'pdf-mineru', envKey: /^PDF_MINERU_API_KEY=/ },
  { name: 'pdf-mineru-cloud', envKey: /^PDF_MINERU_CLOUD_API_KEY=/ },
  { name: 'image-openai', envKey: /^IMAGE_OPENAI_API_KEY=/ },
  { name: 'image-seedream', envKey: /^IMAGE_SEEDREAM_API_KEY=/ },
  { name: 'image-qwen', envKey: /^IMAGE_QWEN_IMAGE_API_KEY=/ },
  { name: 'image-nano-banana', envKey: /^IMAGE_NANO_BANANA_API_KEY=/ },
  { name: 'image-minimax', envKey: /^IMAGE_MINIMAX_API_KEY=/ },
  { name: 'image-grok', envKey: /^IMAGE_GROK_API_KEY=/ },
  { name: 'video-seedance', envKey: /^VIDEO_SEEDANCE_API_KEY=/ },
  { name: 'video-kling', envKey: /^VIDEO_KLING_API_KEY=/ },
  { name: 'video-veo', envKey: /^VIDEO_VEO_API_KEY=/ },
  { name: 'video-sora', envKey: /^VIDEO_SORA_API_KEY=/ },
  { name: 'video-minimax', envKey: /^VIDEO_MINIMAX_API_KEY=/ },
  { name: 'video-grok', envKey: /^VIDEO_GROK_API_KEY=/ },
  { name: 'video-happyhorse', envKey: /^VIDEO_HAPPYHORSE_API_KEY=/ },
  { name: 'websearch-tavily', envKey: /^TAVILY_API_KEY=/ },
  { name: 'websearch-bocha', envKey: /^BOCHA_API_KEY=/ },
  { name: 'websearch-brave', envKey: /^BRAVE_API_KEY=/ },
  { name: 'websearch-baidu', envKey: /^BAIDU_API_KEY=/ },
  { name: 'websearch-claude', envKey: /^WEB_SEARCH_CLAUDE_API_KEY=/ },
  // Philochora specific
  { name: 'aliyun-accesskey', envKey: /^ALIYUN_ACCESS_KEY_ID=/ },
  { name: 'oauth-signing', envKey: /^OAUTH_SIGNING_KEY=/ },
  { name: 'openmaic-service', envKey: /^OPENMAIC_SERVICE_API_KEY=/ },
  { name: 'openmaic-shared', envKey: /^OPENMAIC_SHARED_SECRET=/ },
  { name: 'oauth-client-secret', envKey: /^OAUTH_CLIENT_SECRET=/ },
  { name: 'data-encryption', envKey: /^DATA_ENCRYPTION_KEY=/ },
  { name: 'phone-pepper', envKey: /^PHONE_PEPPER=/ },
  { name: 'aliyun-captcha-ekey', envKey: /^ALIYUN_CAPTCHA_EKEY=/ },
  { name: 'aliyun-captcha-scene', envKey: /^ALIYUN_CAPTCHA_SCENE_ID=/ },
  { name: 'bilibili-sessdata', envKey: /^BILIBILI_SESSDATA=/ },
];

// 推断 environment（基于文件名）
function inferEnv(filename) {
  if (filename.includes('vps')) return 'prod';
  if (filename.includes('production')) return 'prod';
  if (filename.includes('secrets')) return 'prod';
  if (filename.includes('local')) return 'dev';
  if (filename === '.env') return 'dev';
  return 'unknown';
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

function parseEnvFile(filePath) {
  const entries = [];
  if (!existsSync(filePath)) return entries;
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(C.red(`[api-key-inventory] ERROR — 读取失败: ${filePath}: ${err.message}`));
    return entries;
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    // 跳过注释和空行
    if (!line || line.startsWith('#')) continue;
    // 跳过 export 前缀
    const stripped = line.replace(/^export\s+/, '');
    const eqIdx = stripped.indexOf('=');
    if (eqIdx === -1) continue;
    const key = stripped.slice(0, eqIdx).trim();
    let value = stripped.slice(eqIdx + 1).trim();
    // 去掉引号
    value = value.replace(/^['"]|['"]$/g, '');
    if (!value || value.startsWith('change-me') || value.startsWith('your-') || value.startsWith('replace-')) continue;

    // 匹配 provider pattern
    for (const { name, envKey } of PROVIDER_PATTERNS) {
      if (envKey.test(key + '=')) {
        const fp = sha256(value).slice(0, 16);
        entries.push({
          envKeyName: key,
          provider: name,
          valueLength: value.length,
          fingerprint: fp,
          valuePrefix: value.slice(0, 4) + '…',
        });
        break;
      }
    }
  }
  return entries;
}

function scanProject() {
  const allEntries = [];
  for (const filename of TARGET_FILES) {
    const filePath = resolve(projectRoot, filename);
    if (!existsSync(filePath)) continue;
    const env = inferEnv(filename);
    const entries = parseEnvFile(filePath);
    for (const entry of entries) {
      allEntries.push({
        sourceFile: filename,
        environment: env,
        ...entry,
      });
    }
  }
  return allEntries;
}

function formatText(entries) {
  const lines = [];
  lines.push(`[api-key-inventory] 扫描 ${projectRoot}（共 ${entries.length} 条 APIKey）`);
  lines.push('');

  // 按 provider × environment 分组
  const grouped = {};
  for (const e of entries) {
    const k = `${e.provider}/${e.environment}`;
    (grouped[k] ??= []).push(e);
  }

  const keys = Object.keys(grouped).sort();
  for (const k of keys) {
    lines.push(C.green(`  ${k}`));
    for (const e of grouped[k]) {
      lines.push(`    ${e.sourceFile}: ${e.envKeyName}=${e.valuePrefix} (fp=${e.fingerprint}, len=${e.valueLength})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatMd(entries) {
  const lines = [];
  lines.push(`| Source | Environment | Provider | Env Key | Fingerprint | Length |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const e of entries) {
    lines.push(`| \`${e.sourceFile}\` | ${e.environment} | ${e.provider} | \`${e.envKeyName}\` | \`${e.fingerprint}\` | ${e.valueLength} |`);
  }
  lines.push('');
  lines.push('*复制到 [key-owners-roster.md](./key-owners-roster.md) 的 Top-10 表格中*');
  return lines.join('\n');
}

function formatJson(entries) {
  return JSON.stringify(
    {
      projectRoot: relative(process.cwd(), projectRoot) || '.',
      scannedAt: new Date().toISOString(),
      count: entries.length,
      keys: entries,
    },
    null,
    2,
  );
}

function main() {
  const entries = scanProject();
  if (JSON_OUTPUT) {
    console.log(formatJson(entries));
  } else if (MD_OUTPUT) {
    console.log(formatMd(entries));
  } else {
    console.log(formatText(entries));
  }
  process.exit(0);
}

main();