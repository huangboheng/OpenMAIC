/**
 * OAuth 2.0 Client 工具函数
 *
 * PKCE 生成、Token 交换、JWT 解码（仅用于提取用户信息，签名的验证由 Philochora 保证）
 */
import { createHash, randomBytes } from "crypto";

// ── PKCE ──────────────────────────────────────────────────────────

/** 生成 PKCE code_verifier (43 chars, unreserved characters) */
export function generateCodeVerifier(): string {
  return randomBytes(32)
    .toString("base64url")
    .slice(0, 43);
}

/** 生成 PKCE code_challenge (S256) */
export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256")
    .update(verifier)
    .digest()
    .toString("base64url");
}

// ── State (CSRF protection) ──────────────────────────────────────

/** 生成随机 state 参数 */
export function generateState(): string {
  return randomBytes(16).toString("hex");
}

// ── Token Exchange ───────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  id_token: string;
  refresh_token: string;
  scope: string;
}

export interface IdTokenPayload {
  sub: string;
  name?: string;
  picture?: string;
  email?: string;
  aud: string;
  iss: string;
  exp: number;
  iat: number;
  nonce?: string;
}

/**
 * 用 authorization_code 交换 tokens
 */
export async function exchangeCodeForTokens(
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Token exchange failed: ${res.status} ${JSON.stringify(err)}`);
  }

  return res.json();
}

/**
 * 解码 JWT payload（不验证签名，仅提取 sub/name）
 */
export function decodeJwtPayload(token: string): IdTokenPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload) as IdTokenPayload;
  } catch {
    return null;
  }
}

// ── Build Authorization URL ──────────────────────────────────────

export function buildAuthorizationUrl(
  authorizeEndpoint: string,
  clientId: string,
  redirectUri: string,
  scope: string,
  state: string,
  codeChallenge: string,
  nonce?: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  if (nonce) {
    params.set("nonce", nonce);
  }

  return `${authorizeEndpoint}?${params.toString()}`;
}
