/**
 * OpenMAIC Proxy Middleware
 *
 * OAuth 2.0-based authentication via Philochora SSO:
 * 1. Check openmaic_session cookie (HMAC-signed)
 * 2. If invalid/missing → redirect to Philochora /api/oauth/authorize
 * 3. OAuth callback at /api/auth/callback exchanges code for tokens
 * 4. Rate limiting applies as before
 * 5. Service-to-service API key bypass preserved
 */
import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/server/rate-limit';
import {
  verifySessionCookie,
  getSessionSecret,
  COOKIE_NAME,
} from '@/lib/server/session-cookie';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
} from '@/lib/server/oauth-client';
import { verifyAccessTokenEdge } from '@/lib/server/access-token';

// ── Configuration ─────────────────────────────────────────────────

const OAUTH_ISSUER = process.env.OAUTH_ISSUER || 'https://philochora.com';
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'openmaic';

// Seamless-auth cookie issued by Philochora's /api/openmaic/enter endpoint
// (HMAC token signed with the shared ACCESS_CODE — see lib/server/access-token.ts)
const ACCESS_COOKIE_NAME = 'openmaic_access';

// Paths excluded from OAuth redirect
const AUTH_WHITELIST = [
  '/api/auth/callback',
  '/api/health',
  '/api/persistence', // 自带 Bearer Token 认证 (server-auth.ts)，不走 OAuth
  '/api/public',      // 公共资源代理路由（应用层读 public/ 返回），无需鉴权
  '/_next',
  '/favicon.ico',
  '/logos/',
];

// GET-only paths excluded from auth (still subject to rate limiting).
// Classroom data is addressed by unguessable 10-char nanoid; the classroom
// PAGE itself is still auth-gated (307 → OAuth), so exposing the read-only
// data endpoint does not leak content to unauthenticated browsers.
const GET_AUTH_WHITELIST = [
  '/api/classroom',        // GET /api/classroom?id=xxx (read classroom JSON)
  '/api/classroom-media/', // GET /api/classroom-media/:id/:path (media assets)
];

// SEC-02: Entry tightening — OpenMAIC has NO public homepage.
// The only legal page entry is the classroom page (linked from Philochora
// course pages). Root path, eval/generation-preview pages and any other
// non-whitelisted page path must return 404 (application-layer defense,
// Nginx layer enforces the same rule to avoid single point of failure).
const PAGE_ENTRY_PATTERN =
  /^\/classroom\/|^\/api\/|^\/_next(\/|$)|^\/favicon\.ico$|^\/logos\//;

// SEC-03: Rate limit patterns
const HIGH_COST_PATTERN = /^\/api\/(generate-classroom|generate\/(image|video|tts|voice)|export-video|pbl)/;
const GENERAL_API_PATTERN = /^\/api\//;

// ── Helpers ───────────────────────────────────────────────────────

function getClientIp(request: NextRequest): string {
  if (process.env.TRUST_PROXY_HEADERS === 'true') {
    const fwd = request.headers.get('x-forwarded-for');
    if (fwd) return fwd.split(',')[0].trim();
    const real = request.headers.get('x-real-ip');
    if (real) return real.trim();
  }
  return 'direct';
}

function isWhitelisted(pathname: string): boolean {
  return AUTH_WHITELIST.some((p) => pathname.startsWith(p));
}

function isGetWhitelisted(pathname: string, method: string): boolean {
  return method === 'GET' && GET_AUTH_WHITELIST.some((p) => pathname.startsWith(p));
}

/** SEC-01: Verify service-to-service API key (Philochora -> OpenMAIC) */
function verifyServiceApiKey(request: NextRequest): boolean {
  const serviceKey = process.env.OPENMAIC_SERVICE_API_KEY;
  if (!serviceKey) return false;
  const provided = request.headers.get('x-openmaic-api-key');
  if (!provided) return false;
  if (provided.length !== serviceKey.length) return false;
  let mismatch = 0;
  for (let i = 0; i < provided.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ serviceKey.charCodeAt(i);
  }
  return mismatch === 0;
}

// ── Middleware ────────────────────────────────────────────────────

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  let modifiedHeaders: Headers | undefined;

  // SEC-02: Reject any non-whitelisted page path (root /, /eval/*, /generation-preview, ...)
  // before any auth/redirect logic runs. Classroom pages and API endpoints are
  // the only legal entries; everything else is treated as non-existent.
  if (!PAGE_ENTRY_PATTERN.test(pathname)) {
    return new NextResponse('Not Found', { status: 404 });
  }

  // Skip auth for whitelisted paths
  if (isWhitelisted(pathname)) {
    return NextResponse.next();
  }

  // Skip auth for GET-only whitelisted paths (classroom data read).
  // Rate limiting still applies below.
  if (isGetWhitelisted(pathname, request.method)) {
    // Fall through to rate limiting section, then return next()
    if (GENERAL_API_PATTERN.test(pathname)) {
      const ip = getClientIp(request);
      const result = checkRateLimit(`api:${ip}`, 60, 60_000);
      if (!result.allowed) {
        return NextResponse.json(
          { success: false, errorCode: 'RATE_LIMITED', error: 'Too many requests. Please wait.' },
          { status: 429, headers: { 'Retry-After': String(Math.ceil((result.resetAt - Date.now()) / 1000)) } },
        );
      }
    }
    return NextResponse.next();
  }

  // SEC-01: Service-to-service API key bypasses OAuth
  const isService = verifyServiceApiKey(request);

  if (!isService) {
    // Check OAuth session cookie
    const sessionCookie = request.cookies.get(COOKIE_NAME);
    const sessionSecret = getSessionSecret();
    let session = null;

    if (sessionCookie?.value) {
      session = await verifySessionCookie(sessionCookie.value, sessionSecret);
    }

    // Seamless auth: accept the openmaic_access HMAC cookie issued by
    // Philochora's /api/openmaic/enter endpoint (signed with the shared
    // ACCESS_CODE). Restores the no-redirect classroom-entry flow without
    // forcing an OAuth round-trip.
    let seamlessAuthed = false;
    if (!session) {
      const accessToken = request.cookies.get(ACCESS_COOKIE_NAME)?.value;
      const accessCode = process.env.ACCESS_CODE;
      if (accessToken && accessCode) {
        seamlessAuthed = await verifyAccessTokenEdge(accessToken, accessCode);
      }
    }

    if (!session && !seamlessAuthed) {
      // API requests without valid session → 401
      if (pathname.startsWith('/api/')) {
        return NextResponse.json(
          { success: false, errorCode: 'UNAUTHORIZED', error: 'Authentication required' },
          { status: 401 },
        );
      }

      // Page requests → redirect to Philochora OAuth authorize
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateState();

      const redirectUri = `${request.nextUrl.origin}/openmaic/api/auth/callback`;
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: 'openid profile',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });

      const authorizeUrl = `${OAUTH_ISSUER}/api/oauth/authorize?${params.toString()}`;

      const response = NextResponse.redirect(authorizeUrl);

      // Store OAuth params in short-lived cookies for callback verification
      response.cookies.set('oauth_state', state, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 600,
      });
      response.cookies.set('oauth_code_verifier', codeVerifier, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 600,
      });
      response.cookies.set('oauth_return_to', pathname + request.nextUrl.search, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 600,
      });

      return response;
    }

    // Session valid — attach user info to request headers for downstream handlers
    if (session) {
      modifiedHeaders = new Headers(request.headers);
      modifiedHeaders.set('x-user-id', session.sub);
      if (session.name) {
        modifiedHeaders.set('x-user-name', encodeURIComponent(session.name));
      }
    }
  }

  // Rate limiting (applies to all authenticated callers including service)
  if (GENERAL_API_PATTERN.test(pathname)) {
    const ip = isService ? 'service:philochora' : getClientIp(request);

    if (HIGH_COST_PATTERN.test(pathname)) {
      const result = checkRateLimit(`hc:${ip}:${pathname}`, 10, 60_000);
      if (!result.allowed) {
        return NextResponse.json(
          { success: false, errorCode: 'RATE_LIMITED', error: 'Too many requests. Please wait.' },
          { status: 429, headers: { 'Retry-After': String(Math.ceil((result.resetAt - Date.now()) / 1000)) } },
        );
      }
    } else {
      const result = checkRateLimit(`api:${ip}`, 60, 60_000);
      if (!result.allowed) {
        return NextResponse.json(
          { success: false, errorCode: 'RATE_LIMITED', error: 'Too many requests. Please wait.' },
          { status: 429, headers: { 'Retry-After': String(Math.ceil((result.resetAt - Date.now()) / 1000)) } },
        );
      }
    }
  }

  return modifiedHeaders
    ? NextResponse.next({ request: { headers: modifiedHeaders } })
    : NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logos/|api/public/).*)'],
};
