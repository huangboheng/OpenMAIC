/**
 * OAuth 2.0 回调端点 — GET /api/auth/callback
 *
 * 接收 Philochora OAuth Server 的 authorization code，
 * 交换 access_token + id_token + refresh_token，
 * 加密存入 httpOnly Cookie 后重定向到原始页面。
 */
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  exchangeCodeForTokens,
  decodeJwtPayload,
} from "@/lib/server/oauth-client";
import { getOidcConfig, getClientCredentials, getRedirectUri } from "@/lib/server/oauth-config";
import { signSessionCookie, COOKIE_NAME, getSessionSecret, type SessionData } from "@/lib/server/session-cookie";
import { createLogger } from "@/lib/logger";

const log = createLogger("oauth-callback");

const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

/**
 * Handle GET /api/auth/callback
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  // Handle OAuth error response
  if (error) {
    log.error(`[oauth-callback] Authorization error: ${error} — ${searchParams.get("error_description")}`);
    return NextResponse.redirect(new URL("/?error=oauth_denied", request.url));
  }

  if (!code || !state) {
    log.warn("[oauth-callback] Missing code or state parameter");
    return NextResponse.redirect(new URL("/?error=invalid_callback", request.url));
  }

  // Verify state (CSRF protection) — stored in cookie before redirect
  const storedState = request.cookies.get("oauth_state")?.value;
  if (!storedState || storedState !== state) {
    log.warn("[oauth-callback] State mismatch — possible CSRF attack");
    return NextResponse.redirect(new URL("/?error=csrf", request.url));
  }

  // Get stored code_verifier
  const codeVerifier = request.cookies.get("oauth_code_verifier")?.value;
  if (!codeVerifier) {
    log.error("[oauth-callback] Missing code_verifier cookie");
    return NextResponse.redirect(new URL("/?error=missing_verifier", request.url));
  }

  try {
    // Get OIDC config
    const { tokenEndpoint } = await getOidcConfig();
    const { clientId, clientSecret } = getClientCredentials();
    const redirectUri = getRedirectUri();

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(
      tokenEndpoint,
      clientId,
      clientSecret,
      code,
      codeVerifier,
      redirectUri,
    );

    // Decode id_token to get user info
    const idTokenPayload = decodeJwtPayload(tokens.id_token);

    // Build session data
    const sessionData: SessionData = {
      sub: idTokenPayload?.sub || "",
      name: idTokenPayload?.name || "",
      picture: idTokenPayload?.picture || "",
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
    };

    // Sign and set session cookie
    const sessionSecret = getSessionSecret();
    const signedValue = signSessionCookie(sessionData, sessionSecret);

    const cookieStore = await cookies();
    cookieStore.set(COOKIE_NAME, signedValue, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    });

    // Clear one-time OAuth cookies
    cookieStore.set("oauth_state", "", { maxAge: 0, path: "/" });
    cookieStore.set("oauth_code_verifier", "", { maxAge: 0, path: "/" });

    // Get return URL from state (we encode it in a separate cookie)
    const returnTo = request.cookies.get("oauth_return_to")?.value || "/";

    log.info(`[oauth-callback] Login successful: sub=${idTokenPayload?.sub}, name=${idTokenPayload?.name}`);

    const response = NextResponse.redirect(new URL(returnTo, request.url));
    // Clear return_to cookie
    response.cookies.set("oauth_return_to", "", { maxAge: 0, path: "/" });

    return response;
  } catch (err) {
    log.error("[oauth-callback] Token exchange failed:", (err as Error).message);
    return NextResponse.redirect(new URL("/?error=token_exchange_failed", request.url));
  }
}
