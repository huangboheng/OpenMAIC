import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Deleting a course's runtime data, end to end: the real persistence route,
 * the real storage handler and PostgreSQL stores on an in-memory database.
 *
 * The runtime contract gates `DELETE /runtime/stages/<id>` behind an admin
 * check, and this app has no admin identity. The route therefore allows
 * exactly one shape — the course's owner clearing runtime of a course they
 * already tombstoned — and refuses everything else.
 */

class PGlitePool {
  constructor(readonly db: PGlite) {}

  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {
    await this.db.close();
  }
}

const ALICE_COOKIE = '11111111-1111-4111-8111-111111111111';
const BOB_COOKIE = '22222222-2222-4222-8222-222222222222';
const ALICE = `anon:${ALICE_COOKIE}`;
const BOB = `anon:${BOB_COOKIE}`;
const NOW = 1_800_000_000_000;
const ISO = new Date(NOW).toISOString();

type Who = 'alice' | 'bob';

function cookieOf(who: Who): string {
  return `anonymous_id=${who === 'alice' ? ALICE_COOKIE : BOB_COOKIE}`;
}

function courseDocument(stageId: string) {
  return {
    stage: { id: stageId, name: stageId, createdAt: NOW, updatedAt: NOW },
    scenes: [],
    outline: {
      outlines: [],
      requirement: stageId,
      generationComplete: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function sessionInit(id: string, stageId: string, learnerKey: string) {
  return {
    id,
    stageId,
    learnerKey,
    kind: 'chat',
    status: 'active',
    createdAt: ISO,
    updatedAt: ISO,
  };
}

function recordInit(id: string, sessionId: string) {
  return {
    id,
    sessionId,
    createdAt: ISO,
    payload: { role: 'user', content: 'hello' },
  };
}

describe('stage runtime deletion follows the course owner', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://stage-runtime-delete-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', '');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
  });

  afterEach(async () => {
    const { resetOwnerAuthenticationForTests } = await import('@/lib/server/identity/registry');
    resetOwnerAuthenticationForTests();
    await pool.end();
    vi.unstubAllEnvs();
  });

  async function call(
    who: Who,
    path: string,
    init: { method?: string; json?: unknown } = {},
  ): Promise<Response> {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const headers: Record<string, string> = { cookie: cookieOf(who) };
    if (init.json !== undefined) headers['content-type'] = 'application/json';
    return handlePersistenceRequest(
      new Request(`http://localhost/api/persistence${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      }),
      { poolFactory: () => pool as never },
    );
  }

  async function saveCourse(who: Who, stageId: string) {
    const response = await call(who, `/documents/${stageId}`, {
      method: 'PUT',
      json: courseDocument(stageId),
    });
    expect(response.status).toBeLessThan(300);
  }

  async function retire(who: Who, stageId: string) {
    const response = await call(who, `/documents/${stageId}`, { method: 'DELETE' });
    expect(response.status).toBe(204);
  }

  async function createSession(who: Who, sessionId: string, stageId: string) {
    const response = await call(who, '/runtime/sessions', {
      method: 'POST',
      json: sessionInit(sessionId, stageId, who === 'alice' ? ALICE : BOB),
    });
    expect(response.status).toBe(201);
  }

  async function appendRecord(who: Who, sessionId: string, recordId: string) {
    const response = await call(who, `/runtime/sessions/${sessionId}/records`, {
      method: 'POST',
      json: recordInit(recordId, sessionId),
    });
    expect(response.status).toBe(201);
  }

  async function countRows(
    table: 'runtime_sessions' | 'runtime_records',
    column: string,
    value: string,
  ) {
    const result = await pool.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`,
      [value],
    );
    return (result.rows[0] as { n: number }).n;
  }

  it('lets the owner purge runtime of a course they already tombstoned', async () => {
    await saveCourse('alice', 'stage-retired');
    await createSession('alice', 'session-retired', 'stage-retired');
    await appendRecord('alice', 'session-retired', 'record-retired');
    await retire('alice', 'stage-retired');

    const response = await call('alice', '/runtime/stages/stage-retired', { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(await countRows('runtime_sessions', 'stage_id', 'stage-retired')).toBe(0);
    expect(await countRows('runtime_records', 'session_id', 'session-retired')).toBe(0);

    // The route clears runtime, not the tombstone: the course row and its
    // deleted_at marker stay (deletion is a tombstone in this app).
    const meta = await pool.query('SELECT deleted_at FROM stage_meta WHERE stage_id = $1', [
      'stage-retired',
    ]);
    expect(meta.rows).toHaveLength(1);
    expect((meta.rows[0] as { deleted_at: string | Date | null }).deleted_at).not.toBeNull();
    const documentRow = await pool.query('SELECT id FROM document_stages WHERE id = $1', [
      'stage-retired',
    ]);
    expect(documentRow.rows).toHaveLength(1);
  });

  it('is idempotent for the same retired course', async () => {
    await saveCourse('alice', 'stage-twice');
    await retire('alice', 'stage-twice');

    const first = await call('alice', '/runtime/stages/stage-twice', { method: 'DELETE' });
    const second = await call('alice', '/runtime/stages/stage-twice', { method: 'DELETE' });

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
  });

  it('refuses runtime deletion for a course that is still live', async () => {
    await saveCourse('alice', 'stage-live');
    await createSession('alice', 'session-live', 'stage-live');

    const response = await call('alice', '/runtime/stages/stage-live', { method: 'DELETE' });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FORBIDDEN_ADMIN' },
    });
    expect(await countRows('runtime_sessions', 'stage_id', 'stage-live')).toBe(1);
  });

  it('refuses another owner even after the course is tombstoned', async () => {
    await saveCourse('alice', 'stage-alices');
    await createSession('alice', 'session-alices', 'stage-alices');
    await retire('alice', 'stage-alices');

    const response = await call('bob', '/runtime/stages/stage-alices', { method: 'DELETE' });

    expect(response.status).toBe(403);
    expect(await countRows('runtime_sessions', 'stage_id', 'stage-alices')).toBe(1);
  });

  it('refuses a stage this server has no ownership record for', async () => {
    const response = await call('alice', '/runtime/stages/stage-unknown', { method: 'DELETE' });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FORBIDDEN_ADMIN' },
    });
  });

  it('keeps the global runtime wipe refused', async () => {
    const response = await call('alice', '/runtime', { method: 'DELETE' });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FORBIDDEN_ADMIN' },
    });
  });

  it('treats an unaddressable stage id as a refusal, not an error', async () => {
    const response = await call('alice', '/runtime/stages/%00', { method: 'DELETE' });

    expect(response.status).toBe(403);
  });

  it('answers a malformed escape the way the storage contract does', async () => {
    const response = await call('alice', '/runtime/stages/%E0%A4%A', { method: 'DELETE' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
  });
});
