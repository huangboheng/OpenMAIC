import { type NextRequest } from 'next/server';
import { createHmac } from 'crypto';
import { createLogger } from '@/lib/logger';

const log = createLogger('Philochora ChapterComplete');

/**
 * POST /api/philochora/chapter-complete
 *
 * 代理端点：将前端触发的章节完成事件转发到 Philochora 的 tRPC 端点。
 * 在服务端完成 HMAC 签名，避免共享密钥泄露到浏览器。
 *
 * Body: { philochoraUserId, courseSlug, chapterNumber, chapterTitle? }
 * 转发到: PHILOCHORA_BASE_URL/api/trpc/courses.chapterComplete
 */
export async function POST(request: NextRequest) {
  const philoBase = process.env.PHILOCHORA_BASE_URL;
  const sharedSecret = process.env.OPENMAIC_SHARED_SECRET;

  if (!philoBase) {
    log.error('[chapter-complete] PHILOCHORA_BASE_URL 未配置');
    return Response.json({ error: '回调服务未配置' }, { status: 503 });
  }

  if (!sharedSecret) {
    log.error('[chapter-complete] OPENMAIC_SHARED_SECRET 未配置');
    return Response.json({ error: '回调密钥未配置' }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: '无效的请求体' }, { status: 400 });
  }

  const { philochoraUserId, courseSlug, chapterNumber, chapterTitle } = body;
  if (!philochoraUserId || !courseSlug || chapterNumber == null) {
    return Response.json(
      { error: '缺少必需字段: philochoraUserId, courseSlug, chapterNumber' },
      { status: 400 },
    );
  }

  // 构造 HMAC 签名（payload 格式与 Philochora 的 chapterComplete 一致）
  const timestamp = Date.now();
  const nonce = Math.random().toString(36).slice(2, 10);
  const payload = `${philochoraUserId}:${courseSlug}:${chapterNumber}:${timestamp}:${nonce}`;
  const signature = createHmac('sha256', sharedSecret).update(payload).digest('hex');

  try {
    const url = `${philoBase}/api/trpc/courses.chapterComplete`;
    const tRpcBody = {
      userId: Number(philochoraUserId),
      courseSlug: String(courseSlug),
      chapterNumber: Number(chapterNumber),
      chapterTitle: chapterTitle ? String(chapterTitle) : undefined,
      timestamp,
      nonce,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-openmaic-signature': signature,
      },
      body: JSON.stringify(tRpcBody),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn(
        { status: res.status, body: text.slice(0, 200) },
        '[chapter-complete] Philochora 返回非 2xx',
      );
      return Response.json(
        { ok: false, error: `Philochora 返回 ${res.status}` },
        { status: 502 },
      );
    }

    log.info(
      { userId: philochoraUserId, courseSlug, chapterNumber },
      '[chapter-complete] 章节完成回调成功',
    );
    return Response.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, '[chapter-complete] 请求 Philochora 失败');
    return Response.json({ ok: false, error: '回调请求失败' }, { status: 502 });
  }
}
