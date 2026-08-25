import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/scene-content';
import { createHmac } from 'node:crypto';

/**
 * Build a valid signed `openmaic_session` cookie so the OAuth proxy middleware
 * (proxy.ts) admits the fresh E2E browser without a real Philochora login.
 * Mirrors getSessionSecret() resolution on the server side.
 */
function makeSessionCookieValue(): string {
  const secret =
    process.env.OPENMAIC_SESSION_SECRET ||
    process.env.ACCESS_CODE ||
    'openmaic-dev-session-secret';
  const data = {
    sub: 'e2e-user',
    name: 'E2E User',
    picture: '',
    access_token: 'e2e-access-token',
    refresh_token: 'e2e-refresh-token',
    expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

/** Admit the browser past the OAuth middleware and client-side access gate. */
async function bypassAuthGates(page: import('@playwright/test').Page) {
  await page.context().addCookies([
    {
      name: 'openmaic_session',
      value: makeSessionCookieValue(),
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await page.route('**/api/access-code/status', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, authenticated: true }),
    }),
  );
}

const TEST_STAGE_ID = 'e2e-discussion-join';

/**
 * User explicitly selected only default-1/2/3; the discussion trigger agent
 * (default-4) is NOT in the selection. Before the fix, the playback engine
 * silently skipped every discussion action referencing an unselected agent.
 */
const SETTINGS_UNSELECTED_AGENT = createSettingsStorage({
  sidebarCollapsed: false,
  selectedAgentIds: ['default-1', 'default-2', 'default-3'],
  agentSelectionIsUserSet: true,
});

/**
 * No usable LLM provider (empty API key). The settings auto-config resolves an
 * empty modelId, so startDiscussion's validation fails early and returns false,
 * exercising the recovery path back to idle.
 */
const SETTINGS_NO_MODEL = createSettingsStorage({
  sidebarCollapsed: false,
  providersConfig: { openai: { apiKey: '' } },
  selectedAgentIds: ['default-1', 'default-2', 'default-3'],
  agentSelectionIsUserSet: true,
});

/** Mock /api/chat SSE: one agent replies then cues the user. */
async function mockChatStream(page: import('@playwright/test').Page) {
  await page.route('**/api/chat', (route) => {
    const events = [
      {
        type: 'agent_start',
        data: {
          messageId: 'msg-1',
          agentId: 'default-4',
          agentName: 'Thinker',
          agentAvatar: '/avatars/default-4.png',
        },
      },
      {
        type: 'text_delta',
        data: {
          messageId: 'msg-1',
          content: 'Great question! Here is my perspective on this discussion topic.',
        },
      },
      { type: 'agent_end', data: { messageId: 'msg-1', agentId: 'default-4' } },
      {
        type: 'done',
        data: { totalAgents: 1, agentHadContent: true, cueUserReceived: true },
      },
    ];
    const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
    route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
      body,
    });
  });
}

/**
 * Seed IndexedDB with a stage + 1 slide scene whose actions end with a
 * discussion triggered by agent default-4 (NOT in the user's selection).
 */
async function seedDatabase(page: import('@playwright/test').Page, settings: string) {
  await page.addInitScript((settingsJson) => {
    localStorage.setItem('settings-storage', settingsJson);
    localStorage.setItem('locale', 'en-US');
  }, settings);

  // Navigate to home first so Dexie creates the DB at the current version.
  // (SEC-02 returns a bare 404 for '/', so seeding below must also handle a
  // database that was never bootstrapped by the app — see the missing-store
  // fallback in seedStageData.)
  await page.goto('/', { waitUntil: 'networkidle' });

  const seedStageData = () =>
    page.evaluate(({ stageId, theme }) => {
      return new Promise<void>((resolve, reject) => {
        // SEC-02 returns a bare 404 for '/', so the app's Dexie bootstrap never
        // runs and MAIC-Database may not exist yet. indexedDB.open() without a
        // version then yields an EMPTY database (no object stores) and
        // db.transaction() would throw synchronously, hanging this promise.
        // Detect the missing stores and reopen with a bumped version to create
        // them (Dexie upgrades further to its own version on app boot).
        const STORES: Array<[string, string]> = [
          ['stages', 'id'],
          ['scenes', 'id'],
          ['stageOutlines', 'stageId'],
        ];

        const seed = (db: IDBDatabase) => {
          const tx = db.transaction(STORES.map(([name]) => name), 'readwrite');
          const now = Date.now();

          tx.objectStore('stages').put({
            id: stageId,
            name: 'Discussion Join E2E',
            description: '',
            language: 'en-US',
            style: 'professional',
            agentIds: ['default-1', 'default-2', 'default-3', 'default-4', 'default-5', 'default-6'],
            createdAt: now,
            updatedAt: now,
          });

          tx.objectStore('scenes').put({
            id: 'scene-disc-0',
            stageId,
            type: 'slide',
            title: 'Discussion Scene',
            order: 0,
            content: {
              type: 'slide',
              canvas: {
                id: 'slide-disc-0',
                viewportSize: 1000,
                viewportRatio: 0.5625,
                theme,
                elements: [
                  {
                    type: 'text',
                    id: 'el-disc-0',
                    content: 'Discussion trigger scene',
                    left: 50,
                    top: 50,
                    width: 900,
                    height: 100,
                  },
                ],
              },
            },
            actions: [
              {
                id: 'action-speech-1',
                type: 'speech',
                text: 'Let us begin our discussion.',
              },
              {
                id: 'action-disc-1',
                type: 'discussion',
                topic: 'Should we join this discussion?',
                prompt: 'Share your thoughts on the topic.',
                agentId: 'default-4',
              },
            ],
            createdAt: now,
            updatedAt: now,
          });

          tx.objectStore('stageOutlines').put({
            stageId,
            outlines: [],
            createdAt: now,
            updatedAt: now,
          });

          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };

        const request = indexedDB.open('MAIC-Database');

        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const missing = STORES.filter(([name]) => !db.objectStoreNames.contains(name));
          if (missing.length === 0) {
            seed(db);
            return;
          }
          const version = db.version;
          db.close();
          const upgrade = indexedDB.open('MAIC-Database', version + 1);
          upgrade.onupgradeneeded = (e) => {
            const udb = (e.target as IDBOpenDBRequest).result;
            for (const [name, keyPath] of STORES) {
              if (!udb.objectStoreNames.contains(name)) {
                udb.createObjectStore(name, { keyPath });
              }
            }
          };
          upgrade.onsuccess = (e) => seed((e.target as IDBOpenDBRequest).result);
          upgrade.onerror = () => reject(upgrade.error);
        };

        request.onerror = () => reject(request.error);
      });
    }, { stageId: TEST_STAGE_ID, theme: defaultTheme });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await seedStageData();
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Execution context was destroyed') || attempt === 2) {
        throw error;
      }
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(250);
    }
  }
}

test.describe('Discussion Join', () => {
  test('shows ProactiveCard for unselected trigger agent and joins discussion', async ({
    page,
  }) => {
    await bypassAuthGates(page);
    await seedDatabase(page, SETTINGS_UNSELECTED_AGENT);
    await mockChatStream(page);

    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    // Start playback: speech plays (~2s reading timer) then discussion triggers.
    await page.getByRole('button', { name: 'Play', exact: true }).click();

    // ProactiveCard must appear even though default-4 is NOT in selectedAgentIds
    // (trigger delay 3s after the discussion action is reached).
    const joinButton = page.getByRole('button', { name: 'Join', exact: true });
    await expect(joinButton).toBeVisible({ timeout: 12_000 });

    // Join the discussion.
    await joinButton.click();

    // Engine enters live mode: toolbar shows Stop Discussion.
    await expect(page.getByRole('button', { name: 'Stop Discussion', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    // ProactiveCard is dismissed.
    await expect(joinButton).toBeHidden();

    // Agent reply arrives via mocked SSE and appears in the roundtable bubble.
    await expect(
      page.getByText('Great question! Here is my perspective on this discussion topic.'),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('recovers to idle when discussion cannot start (model not configured)', async ({
    page,
  }) => {
    await bypassAuthGates(page);
    await seedDatabase(page, SETTINGS_NO_MODEL);

    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    await page.getByRole('button', { name: 'Play', exact: true }).click();

    const joinButton = page.getByRole('button', { name: 'Join', exact: true });
    await expect(joinButton).toBeVisible({ timeout: 12_000 });
    await joinButton.click();

    // startDiscussion fails validation, so handleLiveSessionError resets state:
    // engine returns to idle (Play button reappears), no live session lingers.
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: 'Stop Discussion', exact: true })).toBeHidden();
  });

  test('loud failure: non-ok server-providers surfaces a visible toast on join (ADR-0001)', async ({
    page,
  }) => {
    await bypassAuthGates(page);
    // Simulate an edge-layer block (nginx-403 shape): fetchServerProviders
    // must not silently swallow the failure — managed-mode users have no
    // settings panel, so a join attempt must produce actionable feedback.
    await page.route('**/api/server-providers', (route) =>
      route.fulfill({ status: 403, contentType: 'text/html', body: '<center>nginx</center>' }),
    );
    await seedDatabase(page, SETTINGS_NO_MODEL);

    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    await page.getByRole('button', { name: 'Play', exact: true }).click();

    const joinButton = page.getByRole('button', { name: 'Join', exact: true });
    await expect(joinButton).toBeVisible({ timeout: 12_000 });
    await joinButton.click();

    // Visible failure feedback is mandatory (the pre-fix behaviour was a
    // silent return to idle with no toast at all in managed mode).
    const toast = page.locator('[data-sonner-toast]');
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toContainText('Failed to load service configuration');

    // The engine must still recover to idle after the failed start.
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: 'Stop Discussion', exact: true })).toBeHidden();
  });

  test('preserves pending discussion trigger across pause and resume', async ({ page }) => {
    await bypassAuthGates(page);
    await seedDatabase(page, SETTINGS_UNSELECTED_AGENT);
    await mockChatStream(page);

    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    await page.getByRole('button', { name: 'Play', exact: true }).click();

    // Wait for the speech action to finish and the discussion trigger delay to
    // start, then pause WITHIN the 3s trigger window.
    await page.getByRole('button', { name: 'Pause', exact: true }).click();

    // While paused past the original trigger deadline, no card may appear.
    await page.waitForTimeout(4_500);
    await expect(page.getByRole('button', { name: 'Join', exact: true })).toBeHidden();

    // Resume: the pending trigger must fire after its remaining delay.
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Join', exact: true })).toBeVisible({
      timeout: 10_000,
    });
  });
});
