import { cookies } from 'next/headers';
import { apiSuccess } from '@/lib/server/api-response';
import { verifyAccessToken } from '@/lib/server/access-token';
import { verifySessionCookie, getSessionSecret, COOKIE_NAME } from '@/lib/server/session-cookie';

export async function GET() {
  const accessCode = process.env.ACCESS_CODE;
  const enabled = !!accessCode;

  let authenticated = false;
  if (enabled) {
    const cookieStore = await cookies();
    // 无缝认证 token（Philochora /api/openmaic/enter 颁发）
    const token = cookieStore.get('openmaic_access')?.value;
    authenticated = !!token && verifyAccessToken(token, accessCode);

    // OAuth 会话（Philochora SSO）：已通过 SSO 登录的用户不应再被访问码
    // 门控重复拦截。与中间件（proxy.ts）的授权模型保持一致——中间件对
    // openmaic_session 与 openmaic_access 取“或”放行；此前此处仅认
    // openmaic_access，导致仅持 OAuth 会话的用户被 AccessCodeModal 全屏
    // 遮罩拦截、课堂内一切交互（含互动游戏）失效。
    if (!authenticated) {
      const sessionCookie = cookieStore.get(COOKIE_NAME)?.value;
      if (sessionCookie) {
        authenticated = !!(await verifySessionCookie(sessionCookie, getSessionSecret()));
      }
    }
  }

  return apiSuccess({ enabled, authenticated });
}
