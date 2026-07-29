/**
 * OAuth 2.0 Client 配置
 *
 * 从 Philochora OIDC Discovery 端点获取配置，或使用环境变量覆盖。
 * 生产环境缓存配置以减少请求。
 */
import { createLogger } from "@/lib/logger";

const log = createLogger("oauth-config");

export interface OidcConfig {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  jwksUri: string;
}

let cachedConfig: OidcConfig | null = null;

/**
 * 获取 OIDC Provider 配置
 * 优先从 discovery 端点获取，失败时使用环境变量回退
 */
export async function getOidcConfig(): Promise<OidcConfig> {
  if (cachedConfig) return cachedConfig;

  const issuer = process.env.OAUTH_ISSUER || "https://philochora.com";

  // Try OIDC Discovery
  try {
    const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
    const res = await fetch(discoveryUrl, { next: { revalidate: 3600 } });
    if (res.ok) {
      const json = await res.json();
      cachedConfig = {
        issuer: json.issuer,
        authorizationEndpoint: json.authorization_endpoint,
        tokenEndpoint: json.token_endpoint,
        userinfoEndpoint: json.userinfo_endpoint,
        jwksUri: json.jwks_uri,
      };
      log.info("[oauth-config] Loaded from discovery endpoint");
      return cachedConfig;
    }
  } catch {
    log.warn("[oauth-config] Discovery failed, falling back to env vars");
  }

  // Fallback: construct from environment
  cachedConfig = {
    issuer,
    authorizationEndpoint: `${issuer}/api/oauth/authorize`,
    tokenEndpoint: `${issuer}/api/oauth/token`,
    userinfoEndpoint: `${issuer}/api/oauth/userinfo`,
    jwksUri: `${issuer}/.well-known/jwks.json`,
  };

  return cachedConfig;
}

/**
 * 获取 OpenMAIC 的 OAuth client 凭据
 */
export function getClientCredentials(): { clientId: string; clientSecret: string } {
  return {
    clientId: process.env.OAUTH_CLIENT_ID || "openmaic",
    clientSecret: process.env.OAUTH_CLIENT_SECRET || "",
  };
}

/**
 * 获取 OpenMAIC 的回调 URL
 */
export function getRedirectUri(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL || process.env.OAUTH_REDIRECT_URI;
  if (base) return `${base}/api/auth/callback`;
  // Default: same origin + OpenMAIC path
  return "/openmaic/api/auth/callback";
}
