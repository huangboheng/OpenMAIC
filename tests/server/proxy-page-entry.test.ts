import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { proxy, config } from '@/proxy';

const FLAG = 'OPENMAIC_HOME_ENABLED';

function pageRequest(pathname: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, { method: 'GET' });
}

describe('proxy page-entry gate', () => {
  let originalFlag: string | undefined;

  beforeEach(() => {
    originalFlag = process.env[FLAG];
    delete process.env[FLAG];
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = originalFlag;
  });

  it('rejects the home page and generation preview when the home flow is off', async () => {
    expect((await proxy(pageRequest('/'))).status).toBe(404);
    expect((await proxy(pageRequest('/generation-preview'))).status).toBe(404);
  });

  it('keeps the classroom entry reachable when the home flow is off', async () => {
    const response = await proxy(pageRequest('/classroom/course-1'));

    expect(response.status).not.toBe(404);
  });

  it('bypasses auth for the standalone home page when the home flow is on', async () => {
    process.env[FLAG] = 'true';

    const home = await proxy(pageRequest('/'));
    const preview = await proxy(pageRequest('/generation-preview'));

    expect(home.headers.get('x-middleware-next')).toBe('1');
    expect(preview.status).not.toBe(404);
  });

  it('declares the basePath root in the matcher', () => {
    expect(config.matcher).toContain('/');
  });

  it('leaves API requests on their existing auth path', async () => {
    const response = await proxy(pageRequest('/api/foo'));

    expect(response.status).toBe(401);
  });
});
