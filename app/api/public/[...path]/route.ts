/**
 * Public 静态资源服务路由（basePath 兼容）
 *
 * Next.js 16 + Turbopack dev 模式下，basePath=/openmaic 部署时 public/ 子目录
 * （如 /openmaic/avatars/*.png）无法被服务（Turbopack 把 .png 误识别为
 * next/image 优化路径并返回 null）。此路由通过应用层读取 public/ 原文件并直接
 * 返回，绕过 Turbopack 的 bug，对独立运行（basePath 为空）也无副作用。
 *
 * 安全：
 * - 路径白名单（仅 avatars/logos/vendor 等 OpenMAIC 已知公共资源前缀）
 * - 拒绝任何包含 .. 或绝对路径的请求
 * - 仅 GET 方法
 *
 * 生产环境：Next.js 自身在 production build 模式下 public/ 资源服务正常，此
 * 路由仅作为 dev 模式下的 fallback。生产部署也可继续保留作为冗余。
 */
import { promises as fs, createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// 公共资源前缀白名单（与 Philochora vite proxy 保持一致）
const ALLOWED_PREFIXES = ['avatars', 'logos', 'vendor'] as const;
// 单文件白名单
const ALLOWED_FILES = new Set(['logo-horizontal.png', 'openmaic-mark.png']);

function isPathSafe(parts: string[]): boolean {
  if (parts.length === 0) return false;
  for (const seg of parts) {
    if (!seg || seg === '.' || seg === '..' || seg.includes('\0')) return false;
  }
  return true;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path: parts } = await ctx.params;
  if (!isPathSafe(parts)) {
    return new Response('Forbidden', { status: 403 });
  }
  const relPath = parts.join('/');
  const first = parts[0];
  const allowed =
    (ALLOWED_PREFIXES as readonly string[]).includes(first) || ALLOWED_FILES.has(relPath);
  if (!allowed) {
    return new Response('Forbidden', { status: 403 });
  }

  const filePath = path.join(process.cwd(), 'public', relPath);
  // 二次校验：解析后仍在 public 目录下
  const publicRoot = path.join(process.cwd(), 'public');
  if (!filePath.startsWith(publicRoot + path.sep) && filePath !== publicRoot) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return new Response('Not Found', { status: 404 });
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_BY_EXT[ext] || 'application/octet-stream';
    // 用 Node 流，避免大文件一次性读入内存
    const nodeStream = createReadStream(filePath);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    return new Response(webStream, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(stat.size),
        // 公共资源缓存 1 小时；Next.js 会自动加 immutable 等头
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
}

// 仅支持 GET；其他方法返回 405
export async function POST(): Promise<Response> {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET' } });
}

// 防止 tree-shake 移除 fs 引用（运行时使用）
void fs;
