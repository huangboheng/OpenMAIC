import { promises as fs, createReadStream } from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { CLASSROOMS_DIR, isValidClassroomId } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('ClassroomMedia');

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
};

/**
 * 路径包含性判定（纵深防御，防路径逃逸）。
 *
 * Windows 文件系统大小写不敏感，但 process.cwd() 拼接出的 base 与
 * fs.realpath 解析结果的大小写可能不一致（实测盘符 e:\ vs E:\ 即令
 * 大小写敏感的 startsWith 恒 false，导致全部媒体文件被误判 404）。
 * 调用方需先对两侧分别 realpath 规范化；win32 上再转小写比较。
 * platform 参数仅为单测可注入，默认取当前运行时。
 */
export function isPathWithinBase(
  realPath: string,
  realBase: string,
  platform: string = process.platform,
): boolean {
  const isWin = platform === 'win32';
  const norm = isWin ? (p: string) => p.toLowerCase() : (p: string) => p;
  const sep = isWin ? '\\' : '/';
  const a = norm(realPath);
  const b = norm(realBase);
  return a === b || a.startsWith(b + sep);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ classroomId: string; path: string[] }> },
) {
  const { classroomId, path: pathSegments } = await params;

  // Validate classroomId
  if (!isValidClassroomId(classroomId)) {
    return NextResponse.json({ error: 'Invalid classroom ID' }, { status: 400 });
  }

  // Validate path segments — no traversal
  const joined = pathSegments.join('/');
  if (joined.includes('..') || pathSegments.some((s) => s.includes('\0'))) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  // Only allow media/ and audio/ subdirectories
  const subDir = pathSegments[0];
  if (subDir !== 'media' && subDir !== 'audio') {
    return NextResponse.json({ error: 'Invalid path' }, { status: 404 });
  }

  const filePath = path.join(CLASSROOMS_DIR, classroomId, ...pathSegments);
  const resolvedBase = path.resolve(CLASSROOMS_DIR, classroomId);

  try {
    // Resolve symlinks and verify the real path stays within the classroom dir.
    // Realpath BOTH sides: comparing a realpath'd child against a raw base
    // misfires on Windows when cwd/realpath casing diverges (all media 404).
    const realPath = await fs.realpath(filePath);
    let realBase = resolvedBase;
    try {
      realBase = await fs.realpath(resolvedBase);
    } catch {
      // Base dir missing ⇒ the file realpath above would already have thrown
      // ENOENT; keep the raw base for the comparison fallback.
    }
    if (!isPathWithinBase(realPath, realBase)) {
      log.warn(
        `Media path escape blocked [classroomId=${classroomId}, path=${joined}]: real=${realPath}, base=${realBase}`,
      );
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const stat = await fs.stat(realPath);
    if (!stat.isFile()) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const ext = path.extname(realPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Stream the file to avoid loading large videos into memory
    const stream = createReadStream(realPath);
    const webStream = new ReadableStream({
      start(controller) {
        stream.on('data', (chunk: Buffer | string) => controller.enqueue(chunk));
        stream.on('end', () => controller.close());
        stream.on('error', (err) => controller.error(err));
      },
      cancel() {
        stream.destroy();
      },
    });

    return new NextResponse(webStream, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(stat.size),
        'Cache-Control': 'public, max-age=86400, immutable',
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    log.error(
      `Classroom media serving failed [classroomId=${classroomId}, path=${joined}]:`,
      error,
    );
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
