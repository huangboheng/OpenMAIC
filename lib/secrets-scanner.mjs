// lib/secrets-scanner.mjs
//
// Secrets 扫描核心库 — 被 check-secrets.mjs（pre-commit）和 check-secrets-history.mjs（CI / 历史回扫）共用。
// 保持单一事实源，避免双仓双脚本漂移。
//
// 设计原则：
//   - 不引入新依赖（纯 Node 18+ 内置 API）
//   - 扫描规则与误报过滤内聚在本文件，便于单元测试与扩展
//   - allowlist 仅匹配路径前缀（不读 git），调用方传入 allowlist override

import { extname } from 'node:path';

// ---------- 规则定义 ----------

export const SECRET_PATTERNS = [
  {
    id: 'openai-sk',
    label: 'OpenAI API Key',
    regex: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/g,
    hint: 'OpenAI key 形式为 sk- 或 sk-proj- 开头；请使用服务端变量，切勿提交',
  },
  {
    id: 'anthropic-sk',
    label: 'Anthropic API Key',
    regex: /\bsk-ant-[A-Za-z0-9\-]{32,}/g,
    hint: 'Anthropic key 形式为 sk-ant- 开头；请使用服务端变量',
  },
  {
    id: 'deepseek-sk',
    label: 'DeepSeek API Key',
    regex: /\bsk-[0-9a-f]{32}\b/gi,
    hint: 'DeepSeek key 为 32 位 hex；请使用服务端变量',
  },
  {
    id: 'minimax-cp',
    label: 'MiniMax API Key (cp- 形式)',
    regex: /\bsk-cp-[A-Za-z0-9_\-]{40,}/g,
    hint: 'MiniMax key 形式为 sk-cp- 开头（>=40 字符）；请使用服务端变量',
  },
  {
    id: 'dashscope-sk',
    label: '阿里云百炼/DashScope API Key',
    regex: /\bsk-[0-9a-f]{32}\b/gi,
    hint: 'DashScope key 为 32 位 hex；请使用服务端变量',
  },
  {
    id: 'aliyun-ak',
    label: '阿里云 AccessKey ID',
    regex: /\bAKID[A-Z0-9]{16,}\b/g,
    hint: '阿里云 AK ID 形式为 AKID[A-Z0-9]{16}；请使用 RAM 角色 + 临时凭证',
  },
  {
    id: 'aws-access-key',
    label: 'AWS Access Key ID',
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    hint: 'AWS AK 形式为 AKIA/ASIA[A-Z0-9]{16}；请使用 IAM 角色',
  },
  {
    id: 'github-pat',
    label: 'GitHub Personal Access Token',
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    hint: 'GitHub PAT 形式为 ghp_/ghs_/gho_/ghu_/ghr_ 开头',
  },
  {
    id: 'slack-token',
    label: 'Slack Token',
    regex: /\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/g,
    hint: 'Slack token 形式为 xox[baprs]- 开头',
  },
  {
    id: 'generic-key-value',
    label: '通用 KEY/TOKEN/SECRET 赋值',
    // 不太严格，避免误伤：要求 key 名显式含 key/token/secret/api + 长度 >= 20
    regex: /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|bearer[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{20,}['"]?/gi,
    hint: '通用 KEY/TOKEN/SECRET 赋值；如为示例请改为占位符或加 allowlist',
  },
  {
    id: 'bearer-token',
    label: 'Authorization Bearer Token',
    regex: /\bBearer\s+[A-Za-z0-9_\-\.]{20,}/g,
    hint: 'Bearer token 不要写在代码中；请从环境变量读取',
  },
  {
    id: 'next-public-secret',
    label: 'NEXT_PUBLIC_* 包含密钥值（会被编译进前端 bundle）',
    regex: /\bNEXT_PUBLIC_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\s*=\s*['"]?[^\s'"#]{16,}/g,
    hint: 'NEXT_PUBLIC_* 变量会被编译到前端 bundle；密钥必须留在服务端，改用普通环境变量',
  },
];

// ---------- 默认 allowlist ----------

const DEFAULT_ALLOWLIST_PATTERNS = [
  /\/\.env\.example$/,
  /\.example$/,
  /\.test\.[mc]?[jt]sx?$/,
  /\.spec\.[mc]?[jt]sx?$/,
  /\/_archive\//,
  /\bcheck-secrets(?:-history)?\.mjs$/, // 自指
];

// 纯文档扩展名永远不被扫描
const DOC_EXT = new Set(['md', 'markdown', 'txt', 'rst', 'adoc', 'pdf']);

// 占位符 hint（前缀 12 字符内匹配）
const PLACEHOLDER_HINTS = [
  'your-',
  'change-me',
  'replace-',
  'xxx',
  'XXXX',
  'placeholder',
  '<',
  '示例',
  'example',
  'todo',
  'fill-in',
  'sample-',
  'fake-',
];

// ---------- 工具函数 ----------

export function isAllowlisted(relPath, extraPatterns = []) {
  const all = [...DEFAULT_ALLOWLIST_PATTERNS, ...extraPatterns];
  return all.some((re) => re.test(relPath));
}

export function isProbablyPlaceholder(value) {
  const lower = value.toLowerCase();
  // 仅检查 value 前缀 12 字符（避免 AKIAIOSFODNN7EXAMPLE 中的 'example' 子串误判）
  const head = lower.slice(0, 12);
  return PLACEHOLDER_HINTS.some((hint) => head.includes(hint));
}

export function isLikelyRealSecret(value) {
  if (!value) return false;
  // 排除明显占位符
  if (isProbablyPlaceholder(value)) return false;

  // 排除看起来像随机短串的“假 key”（例如测试中的 'sk-test12345678901234567'）
  // 启发式：包含 5+ 连续相同字符 OR 全部为单一字符类 → 大概率是测试 mock
  if (/(.)\1{5,}/.test(value)) return false;

  // 排除长度过短（可能是变量名片段）
  if (value.length < 20) return false;

  // 真实 key 几乎都有字母 + 非字母（数字 / 符号 / 下划线）混合
  // （放宽为“任一字母 + 任一非字母”，避免过滤 AKID1234… 这类全大写+数字的 key）
  const hasAlpha = /[a-zA-Z]/.test(value);
  const hasNonAlpha = /[^a-zA-Z]/.test(value);
  if (!hasAlpha || !hasNonAlpha) return false;

  return true;
}

// ---------- 扫描入口 ----------

/**
 * 扫描给定的 lines（[{ file, line, text }]）并返回命中列表。
 * @param {Array<{file: string, line: number, text: string}>} lines
 * @param {{ extraAllowlist?: RegExp[] }} [opts]
 * @returns {Array<{id: string, label: string, file: string, line: number, snippet: string, match: string, hint: string}>}
 */
export function scan(lines, opts = {}) {
  const hits = [];
  for (const { file, line, text } of lines) {
    if (isAllowlisted(file, opts.extraAllowlist)) continue;
    if (DOC_EXT.has(extname(file).slice(1).toLowerCase())) continue;

    for (const p of SECRET_PATTERNS) {
      // 重置 regex lastIndex（g 标志）
      p.regex.lastIndex = 0;
      let m;
      while ((m = p.regex.exec(text)) !== null) {
        const matched = m[0];
        // 提取关键值用于 placeholder 检查
        const value = matched.replace(/^.*?[:=]\s*['"]?/, '').replace(/['"]?$/, '');
        if (!isLikelyRealSecret(value)) continue;
        hits.push({
          id: p.id,
          label: p.label,
          file,
          line,
          snippet: text.trim().slice(0, 160),
          match: matched.slice(0, 40) + (matched.length > 40 ? '…' : ''),
          hint: p.hint,
        });
      }
    }
  }
  // 去重（同一 file:line 同一 pattern id 仅报一次）
  const seen = new Set();
  return hits.filter((h) => {
    const k = `${h.file}:${h.line}:${h.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- 内置基准 fixture ----------

/**
 * 返回内置基准 fixture（覆盖占位符零误报 + 真实密钥命中验证）。
 * 调用方直接 `scan(fixtureLines())` 即可。
 */
export function fixtureLines() {
  return [
    // 占位符应零命中
    { file: 'fixture:placeholder', line: 1, text: 'OPENAI_API_KEY=sk-your-openai-api-key-here' },
    { file: 'fixture:placeholder', line: 2, text: 'DEEPSEEK_API_KEY=sk-replace-with-real-deepseek-key' },
    { file: 'fixture:placeholder', line: 3, text: 'APP_SECRET=change-me-to-64-char-hex-random-string' },
    { file: 'fixture:placeholder', line: 4, text: 'AUTH_TOKEN=sk-test1234567890' },
    { file: 'fixture:placeholder', line: 5, text: 'SECRET_KEY=sk-aaaaaaaaaaaaaa' },
    { file: 'fixture:placeholder', line: 6, text: 'OAUTH_CLIENT_SECRET=your-secret-key-here' },
    { file: 'fixture:placeholder', line: 7, text: 'API_KEY=replace-this-with-real-token' },
    { file: 'fixture:placeholder', line: 8, text: 'TOKEN=fill-in-with-actual-credentials' },
    { file: 'fixture:placeholder', line: 9, text: '# see https://example.com/docs/api-keys for the key format' },
    { file: 'fixture:placeholder', line: 10, text: "// example: your-deepseek-key-here (not a real key)" },
    // 真实密钥应命中
    { file: 'fixture:real', line: 11, text: 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCD' },
    { file: 'fixture:real', line: 12, text: 'ANTHROPIC_API_KEY=sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz' },
    { file: 'fixture:real', line: 13, text: 'ALIYUN_AK=AKID1234567890ABCDEF' },
    { file: 'fixture:real', line: 14, text: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE' },
    { file: 'fixture:real', line: 15, text: 'NEXT_PUBLIC_BAD=NEXT_PUBLIC_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCD' },
    { file: 'fixture:real', line: 16, text: 'AUTH_HEADER=Authorization: Bearer sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCD' },
  ];
}
