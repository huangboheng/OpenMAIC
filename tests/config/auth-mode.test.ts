import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTH_MODE_ENV,
  resolveAuthMode,
  validateAuthModeConfiguration,
} from '@/lib/config/auth-mode';

const ACCESS_CODE = 'test-access-code-0123456789';

describe('auth mode', () => {
  let originalMode: string | undefined;
  let originalAccessCode: string | undefined;

  beforeEach(() => {
    originalMode = process.env[AUTH_MODE_ENV];
    originalAccessCode = process.env.ACCESS_CODE;
    delete process.env[AUTH_MODE_ENV];
    delete process.env.ACCESS_CODE;
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env[AUTH_MODE_ENV];
    else process.env[AUTH_MODE_ENV] = originalMode;
    if (originalAccessCode === undefined) delete process.env.ACCESS_CODE;
    else process.env.ACCESS_CODE = originalAccessCode;
  });

  it('defaults to oauth when the mode is unset or blank', () => {
    expect(resolveAuthMode()).toBe('oauth');

    process.env[AUTH_MODE_ENV] = '   ';
    expect(resolveAuthMode()).toBe('oauth');
  });

  it('accepts access-code only when a code is configured', () => {
    process.env[AUTH_MODE_ENV] = ' access-code ';
    expect(resolveAuthMode()).toBe('oauth');

    process.env.ACCESS_CODE = ACCESS_CODE;
    expect(resolveAuthMode()).toBe('access-code');
  });

  it('fails closed for unknown values', () => {
    process.env[AUTH_MODE_ENV] = 'accesscode';
    process.env.ACCESS_CODE = ACCESS_CODE;

    expect(resolveAuthMode()).toBe('oauth');
    expect(() => validateAuthModeConfiguration()).toThrow(/must be "oauth" or "access-code"/);
  });

  it('rejects access-code without ACCESS_CODE at boot', () => {
    process.env[AUTH_MODE_ENV] = 'access-code';

    expect(resolveAuthMode()).toBe('oauth');
    expect(() => validateAuthModeConfiguration()).toThrow(/requires ACCESS_CODE/);
  });

  it('accepts oauth and a complete access-code configuration', () => {
    expect(() => validateAuthModeConfiguration()).not.toThrow();

    process.env[AUTH_MODE_ENV] = 'oauth';
    expect(() => validateAuthModeConfiguration()).not.toThrow();

    process.env[AUTH_MODE_ENV] = 'access-code';
    process.env.ACCESS_CODE = ACCESS_CODE;
    expect(() => validateAuthModeConfiguration()).not.toThrow();
  });
});
