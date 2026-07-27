import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/server/rate-limit';

/** Convert string to Uint8Array */
function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/** Convert ArrayBuffer to hex string */
function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Verify an HMAC-signed token using Web Crypto API (Edge-compatible) */
async function verifyToken(token: string, accessCode: string): Promise<boolean> {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;

  const timestamp = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);

  // SEC-07: Token expiry — reject tokens older than 7 days
  const ts = Number(timestamp);
  if (Number.isFinite(ts) && Date.now() - ts > 7 * 24 * 60 * 60 * 1000) {
    return false;
  }

  const keyData = encode(accessCode);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const data = encode(timestamp);
  const expected = bufToHex(await crypto.subtle.sign('HMAC', key, data.buffer as ArrayBuffer));

  if (signature.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
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

// SEC-03: High-cost endpoint patterns for stricter rate limiting
const HIGH_COST_PATTERN = /^\/api\/(generate-classroom|generate\/(image|video|tts|voice)|export-video|pbl)/;
const GENERAL_API_PATTERN = /^\/api\//;

function getClientIp(request: NextRequest): string {
  if (process.env.TRUST_PROXY_HEADERS === 'true') {
    const fwd = request.headers.get('x-forwarded-for');
    if (fwd) return fwd.split(',')[0].trim();
    const real = request.headers.get('x-real-ip');
    if (real) return real.trim();
  }
  return 'direct';
}

export async function middleware(request: NextRequest) {
  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  // Whitelist: access-code endpoints, health check
  if (pathname.startsWith('/api/access-code/') || pathname === '/api/health') {
    return NextResponse.next();
  }

  // SEC-01: Service-to-service API key bypasses cookie auth (but still rate-limited)
  const isService = verifyServiceApiKey(request);

  if (!isService) {
    // Check cookie — validate HMAC signature
    const cookie = request.cookies.get('openmaic_access');
    if (!cookie?.value || !(await verifyToken(cookie.value, accessCode))) {
      // API requests without valid cookie → 401
      if (pathname.startsWith('/api/')) {
        return NextResponse.json(
          { success: false, errorCode: 'INVALID_REQUEST', error: 'Access code required' },
          { status: 401 },
        );
      }
      // Page requests → let through, frontend shows modal
      return NextResponse.next();
    }
  }

  // SEC-03: Rate limiting (applies to all authenticated callers including service)
  if (GENERAL_API_PATTERN.test(pathname)) {
    const ip = isService ? 'service:philochora' : getClientIp(request);

    if (HIGH_COST_PATTERN.test(pathname)) {
      // High-cost: 10 req/min (LLM/image/video/TTS generation)
      const result = checkRateLimit(`hc:${ip}:${pathname}`, 10, 60_000);
      if (!result.allowed) {
        return NextResponse.json(
          { success: false, errorCode: 'RATE_LIMITED', error: 'Too many requests. Please wait.' },
          { status: 429, headers: { 'Retry-After': String(Math.ceil((result.resetAt - Date.now()) / 1000)) } },
        );
      }
    } else {
      // General API: 60 req/min
      const result = checkRateLimit(`api:${ip}`, 60, 60_000);
      if (!result.allowed) {
        return NextResponse.json(
          { success: false, errorCode: 'RATE_LIMITED', error: 'Too many requests. Please wait.' },
          { status: 429, headers: { 'Retry-After': String(Math.ceil((result.resetAt - Date.now()) / 1000)) } },
        );
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logos/).*)'],
};
