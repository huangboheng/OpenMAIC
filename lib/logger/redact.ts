/**
 * lib/logger/redact.ts
 *
 * 日志脱敏中间件（阶段 5 B4）。
 *
 * 目标：所有 logger 输出在 format 前调用 redact()，防止 `Bearer sk-...` 等密钥片段落盘。
 *
 * 规则：
 *   - sk-XXX（OpenAI / Anthropic / DeepSeek / DashScope / MiniMax / Bocha）
 *   - AKIDXXX / AKIAXXX（阿里云 / AWS AK）
 *   - xox[abprs]-（Slack）
 *   - ghp_XXX（GitHub PAT）
 *   - Bearer XXX / Authorization: Bearer XXX
 *   - api_key / secret_key / access_token / ... = XXX（通用）
 *
 * 替换策略：保留 provider 标识 + 前 4 字符指纹，方便溯源而不暴露密钥。
 */

const REDACTION_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
  // OpenAI / Anthropic / DeepSeek / DashScope / MiniMax / Bocha — sk- 前缀
  { pattern: /\bsk-(?:proj-|cp-|ant-)?[A-Za-z0-9_\-]{16,}/g, provider: 'sk' },
  // 阿里云 AK
  { pattern: /\bAKID[A-Z0-9]{16,}/g, provider: 'aliyun-ak' },
  // AWS AK
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}/g, provider: 'aws-ak' },
  // GitHub PAT
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/g, provider: 'github-pat' },
  // Slack
  { pattern: /\bxox[abprs]-[A-Za-z0-9\-]{10,}/g, provider: 'slack' },
  // Bearer token
  { pattern: /\bBearer\s+[A-Za-z0-9_\-\.]{20,}/g, provider: 'bearer' },
  // api_key= / secret_key= / access_token= / client_secret=
  {
    pattern: /(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|bearer[_-]?token)\s*[=:]\s*['"]?[A-Za-z0-9_\-]{20,}['"]?/gi,
    provider: 'generic',
  },
];

/**
 * 简单 fingerprint：保留前 4 + 后 4 字符，中间用 *** 替代。
 * 比 sha256 更快，适合热路径（每个日志行都调）。
 */
function quickFingerprint(s: string): string {
  if (s.length <= 12) return '***';
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

/**
 * 脱敏一段字符串。
 * 输入：原始日志字符串
 * 输出：替换所有密钥片段为 `[REDACTED:provider:fp]` 格式
 */
export function redact(input: string): string {
  if (!input || typeof input !== 'string') return input;
  let result = input;
  for (const { pattern, provider } of REDACTION_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => `[REDACTED:${provider}:${quickFingerprint(match)}]`);
  }
  return result;
}

/**
 * 深度 redact：处理对象（包括嵌套对象、数组）的所有 string 字段。
 * 用于结构化日志（log.info({ token, user }, 'msg')）。
 */
export function redactDeep<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return redact(input) as unknown as T;
  if (Array.isArray(input)) return input.map((item) => redactDeep(item)) as unknown as T;
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as unknown as T;
  }
  return input;
}

/**
 * 同步：检查 redact 是否会改变输入（用于单元测试）
 */
export function needsRedaction(input: string): boolean {
  if (!input) return false;
  for (const { pattern } of REDACTION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(input)) return true;
  }
  return false;
}