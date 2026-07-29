/**
 * Session Cookie Utilities
 *
 * HMAC-signed cookie for OpenMAIC session data.
 * - Sign: uses Node.js crypto (server-side: callback route)
 * - Verify: uses Web Crypto API (Edge-compatible: middleware)
 *
 * Both functions produce identical HMAC-SHA256 signatures.
 */

import { createHmac } from "crypto";

const COOKIE_NAME = "openmaic_session";

export interface SessionData {
  sub: string;
  name: string;
  picture: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

// ── Server-side signing (Node.js, used in callback route) ────────

/** Sign session data into cookie value */
export function signSessionCookie(data: SessionData, secret: string): string {
  const json = JSON.stringify(data);
  const encoded = Buffer.from(json).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

// ── Edge-compatible verification (Web Crypto API) ────────────────

const encoder = new TextEncoder();

/** Base64url decode (Edge-compatible, no Node.js Buffer) */
function base64UrlDecode(str: string): string {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, "=");
  const binaryString = atob(padded);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

async function hmacSha256(key: string, data: string): Promise<string> {
  const keyData = encoder.encode(key);
  const dataBuf = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", cryptoKey, dataBuf);
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/** Verify and decode session cookie value (Edge-compatible) */
export async function verifySessionCookie(
  cookieValue: string,
  secret: string,
): Promise<SessionData | null> {
  try {
    const dotIndex = cookieValue.lastIndexOf(".");
    if (dotIndex === -1) return null;

    const encoded = cookieValue.substring(0, dotIndex);
    const signature = cookieValue.substring(dotIndex + 1);

    // Verify HMAC
    const expected = await hmacSha256(secret, encoded);
    if (signature !== expected) return null;

    // Decode payload (Edge-compatible, no Buffer)
    const json = base64UrlDecode(encoded);
    const data = JSON.parse(json) as SessionData;

    // Check expiry
    if (data.expires_at && Date.now() > data.expires_at) return null;

    // Check required field
    if (!data.sub) return null;

    return data;
  } catch {
    return null;
  }
}

/** Get session secret from environment */
export function getSessionSecret(): string {
  return process.env.OPENMAIC_SESSION_SECRET
    || process.env.ACCESS_CODE
    || "openmaic-dev-session-secret";
}

export { COOKIE_NAME };
