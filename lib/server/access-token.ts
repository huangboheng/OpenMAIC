import { createHmac, timingSafeEqual } from 'crypto';

/** Create an HMAC-signed token: `timestamp.signature` */
export function createAccessToken(accessCode: string): string {
  const timestamp = Date.now().toString();
  const signature = createHmac('sha256', accessCode).update(timestamp).digest('hex');
  return `${timestamp}.${signature}`;
}

/** Verify an HMAC-signed token against the access code */
export function verifyAccessToken(token: string, accessCode: string): boolean {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;

  const timestamp = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);

  const expected = createHmac('sha256', accessCode).update(timestamp).digest('hex');

  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return false;

  return timingSafeEqual(sigBuf, expBuf);
}

// ── Edge-compatible verification (Web Crypto API, for middleware) ──

const edgeEncoder = new TextEncoder();

/** HMAC-SHA256 → hex string (Edge-compatible, no Node.js Buffer/crypto) */
async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    edgeEncoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, edgeEncoder.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Edge-compatible variant of {@link verifyAccessToken} for use in Next.js
 * middleware (Edge Runtime cannot use Node.js `crypto`/`Buffer`).
 * Produces the same hex HMAC-SHA256 signature and compares in constant time.
 */
export async function verifyAccessTokenEdge(token: string, accessCode: string): Promise<boolean> {
  try {
    const dotIndex = token.indexOf('.');
    if (dotIndex === -1) return false;

    const timestamp = token.substring(0, dotIndex);
    const signature = token.substring(dotIndex + 1);

    const expected = await hmacSha256Hex(accessCode, timestamp);
    if (signature.length !== expected.length) return false;

    // Constant-time comparison (Web Crypto has no timingSafeEqual)
    let mismatch = 0;
    for (let i = 0; i < signature.length; i++) {
      mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return mismatch === 0;
  } catch {
    return false;
  }
}
