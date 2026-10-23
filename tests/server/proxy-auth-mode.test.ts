import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { proxy } from '@/proxy';
import { createAccessToken } from '@/lib/server/access-token';

const ACCESS_CODE = 'test-access-code-0123456789';
const ENV_KEYS = ['OPENMAIC_AUTH_MODE', 'ACCESS_CODE', 'OPENMAIC_HOME_ENABLED'] as const;

function request(
  pathname: string,
  options: { method?: string; cookie?: string } = {},
): NextRequest {
  const headers = new Headers();
  if (options.cookie) headers.set('cookie', `openmaic_access=${options.cookie}`);
  return new NextRequest(`http://localhost${pathname}`, {
    method: options.method ?? 'GET',
    headers,
  });
}

function setAccessCodeMode(): void {
  process.env.OPENMAIC_AUTH_MODE = 'access-code';
  process.env.ACCESS_CODE = ACCESS_CODE;
}

describe('proxy auth mode', () => {
  let originals: Record<string, string | undefined>;

  beforeEach(() => {
    originals = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key];
    }
  });

  it('keeps the OAuth path when the mode is unset', async () => {
    process.env.OPENMAIC_HOME_ENABLED = 'true';

    expect((await proxy(request('/api/access-code/status'))).status).toBe(401);
    expect((await proxy(request('/generation-preview'))).status).toBe(307);
    expect((await proxy(request('/api/stages'))).status).toBe(401);
  });

  it('lets pages and the access-code endpoints through in access-code mode', async () => {
    setAccessCodeMode();
    process.env.OPENMAIC_HOME_ENABLED = 'true';

    for (const pathname of ['/', '/generation-preview', '/classroom/course-1']) {
      const response = await proxy(request(pathname));
      expect(response.headers.get('x-middleware-next')).toBe('1');
    }

    const status = await proxy(request('/api/access-code/status'));
    expect(status.headers.get('x-middleware-next')).toBe('1');

    const verify = await proxy(request('/api/access-code/verify', { method: 'POST' }));
    expect(verify.headers.get('x-middleware-next')).toBe('1');

    expect((await proxy(request('/api/access-code/verify'))).status).toBe(401);
    expect((await proxy(request('/api/stages'))).status).toBe(401);
  });

  it('accepts a valid access cookie for other APIs in access-code mode', async () => {
    setAccessCodeMode();
    process.env.OPENMAIC_HOME_ENABLED = 'true';

    const response = await proxy(
      request('/api/stages', { cookie: createAccessToken(ACCESS_CODE) }),
    );

    expect(response.status).not.toBe(401);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('keeps the hosted page allowlist when home is off', async () => {
    setAccessCodeMode();

    expect((await proxy(request('/generation-preview'))).status).toBe(404);

    const classroom = await proxy(request('/classroom/course-1'));
    expect(classroom.headers.get('x-middleware-next')).toBe('1');

    const status = await proxy(request('/api/access-code/status'));
    expect(status.headers.get('x-middleware-next')).toBe('1');
  });

  it('falls back to OAuth when access-code mode has no ACCESS_CODE', async () => {
    process.env.OPENMAIC_AUTH_MODE = 'access-code';
    process.env.OPENMAIC_HOME_ENABLED = 'true';

    expect((await proxy(request('/api/access-code/status'))).status).toBe(401);
    expect((await proxy(request('/generation-preview'))).status).toBe(307);
  });
});
