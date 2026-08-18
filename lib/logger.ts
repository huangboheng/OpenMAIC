const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

// 阶段 5 B4：脱敏中间件
import { redact, redactDeep } from './logger/redact';

function getMinLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return env in LOG_LEVELS ? (env as LogLevel) : 'info';
}

function isJsonFormat(): boolean {
  return process.env.LOG_FORMAT === 'json';
}

function formatLine(level: LogLevel, tag: string, args: unknown[]): string {
  const timestamp = new Date().toISOString();
  const upperLevel = level.toUpperCase();
  const msg = args
    .map((a) => {
      if (a instanceof Error) return redact(a.stack ?? a.message);
      if (typeof a === 'string') return redact(a);
      // JSON 序列化后脱敏（处理嵌套对象中的 string 字段）
      return JSON.stringify(redactDeep(a));
    })
    .join(' ');

  if (isJsonFormat()) {
    return JSON.stringify({ timestamp, level: upperLevel, tag, message: msg });
  }
  return `[${timestamp}] [${upperLevel}] [${tag}] ${msg}`;
}

export function createLogger(tag: string) {
  const emit = (level: LogLevel, args: unknown[]) => {
    if (LOG_LEVELS[level] < LOG_LEVELS[getMinLevel()]) return;

    const line = formatLine(level, tag, args);

    // Console output
    const fn =
      level === 'debug'
        ? console.debug
        : level === 'warn'
          ? console.warn
          : level === 'error'
            ? console.error
            : console.log;
    fn(line);
  };

  return {
    debug: (...args: unknown[]) => emit('debug', args),
    info: (...args: unknown[]) => emit('info', args),
    warn: (...args: unknown[]) => emit('warn', args),
    error: (...args: unknown[]) => emit('error', args),
  };
}
