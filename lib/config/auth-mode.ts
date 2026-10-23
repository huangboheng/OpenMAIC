/**
 * Which credential the proxy accepts for page and API requests.
 *
 * `oauth` is the hosted Philochora path. `access-code` is the standalone path:
 * the proxy lets pages reach the client-side AccessCodeGuard and exposes only
 * the two access-code endpoints, while every other API stays authenticated.
 *
 * Unknown or incomplete configuration resolves to `oauth` so a typo can never
 * open the gate; `validateAuthModeConfiguration` turns those cases into a boot
 * failure instead of a silent fallback.
 */
export type AuthMode = 'oauth' | 'access-code';

export const AUTH_MODE_ENV = 'OPENMAIC_AUTH_MODE';

function readAccessCode(): string | undefined {
  return process.env.ACCESS_CODE?.trim() || undefined;
}

export function resolveAuthMode(): AuthMode {
  const configured = process.env[AUTH_MODE_ENV]?.trim();
  if (configured !== 'access-code') return 'oauth';
  return readAccessCode() ? 'access-code' : 'oauth';
}

export function validateAuthModeConfiguration(): void {
  const configured = process.env[AUTH_MODE_ENV]?.trim();
  if (!configured || configured === 'oauth') return;
  if (configured !== 'access-code') {
    throw new Error(
      `${AUTH_MODE_ENV} must be "oauth" or "access-code", got ` +
        `${JSON.stringify(process.env[AUTH_MODE_ENV])}.`,
    );
  }
  if (!readAccessCode()) {
    throw new Error(
      `${AUTH_MODE_ENV}=access-code requires ACCESS_CODE; set ACCESS_CODE or ` +
        `switch ${AUTH_MODE_ENV} to "oauth".`,
    );
  }
}
