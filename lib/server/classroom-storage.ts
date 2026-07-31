import { promises as fs } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import type { Scene, Stage } from '@/lib/types/stage';

export const CLASSROOMS_DIR = path.join(process.cwd(), 'data', 'classrooms');
export const CLASSROOM_JOBS_DIR = path.join(process.cwd(), 'data', 'classroom-jobs');

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureClassroomsDir() {
  await ensureDir(CLASSROOMS_DIR);
}

export async function ensureClassroomJobsDir() {
  await ensureDir(CLASSROOM_JOBS_DIR);
}

export async function writeJsonFileAtomic(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(tempFilePath, content, 'utf-8');

  // Retry rename up to 3 times (Windows Defender / file watcher can cause transient EPERM)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.rename(tempFilePath, filePath);
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EPERM' || code === 'EACCES') {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
          continue;
        }
        // Final fallback: direct write + cleanup tmp
        await fs.writeFile(filePath, content, 'utf-8');
        await fs.unlink(tempFilePath).catch(() => {});
        return;
      }
      throw err;
    }
  }
}

export function buildRequestOrigin(req: NextRequest): string {
  // 子路径部署：配置 basePath 时返回相对前缀，使课堂/媒体资源 URL 走主站同源代理
  // （携带访问 cookie、避免跨域被浏览器拦截）；独立运行时回退到绝对 origin
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH;
  if (basePath) return basePath;
  // SEC-10: Only trust forwarded headers when operator explicitly enables it
  const trustProxy = process.env.TRUST_PROXY_HEADERS === 'true';
  const fwdHost = trustProxy ? req.headers.get('x-forwarded-host') : null;
  if (fwdHost) {
    const proto = req.headers.get('x-forwarded-proto') || 'http';
    return proto + '://' + fwdHost;
  }
  return req.nextUrl.origin;
}

export interface PersistedClassroomData {
  id: string;
  stage: Stage;
  scenes: Scene[];
  createdAt: string;
}

export function isValidClassroomId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

/** 将持久化数据中的绝对媒体 URL 重写为 basePath 相对路径（兼容历史数据） */
function rewriteAbsoluteMediaUrls<T>(data: T): T {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH;
  if (!basePath) return data;
  const pattern = /https?:\/\/[^/"]+\/(api\/classroom-media\/)/g;
  const transform = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(pattern, `${basePath}/$1`);
    if (Array.isArray(value)) return value.map(transform);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = transform(v);
      return out;
    }
    return value;
  };
  return transform(data) as T;
}

export async function readClassroom(id: string): Promise<PersistedClassroomData | null> {
  const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return rewriteAbsoluteMediaUrls(JSON.parse(content)) as PersistedClassroomData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function persistClassroom(
  data: {
    id: string;
    stage: Stage;
    scenes: Scene[];
  },
  baseUrl: string,
): Promise<PersistedClassroomData & { url: string }> {
  const classroomData: PersistedClassroomData = {
    id: data.id,
    stage: data.stage,
    scenes: data.scenes,
    createdAt: new Date().toISOString(),
  };

  await ensureClassroomsDir();
  const filePath = path.join(CLASSROOMS_DIR, `${data.id}.json`);
  await writeJsonFileAtomic(filePath, classroomData);

  return {
    ...classroomData,
    url: `${baseUrl}/classroom/${data.id}`,
  };
}
