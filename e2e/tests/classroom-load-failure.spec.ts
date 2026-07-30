import { test, expect } from '../fixtures/base';
import { createHmac } from 'node:crypto';

/**
 * Build a valid signed `openmaic_session` cookie so the OAuth proxy middleware
 * (proxy.ts) admits the fresh E2E browser without a real Philochora login. The
 * secret mirrors getSessionSecret() (ACCESS_CODE from .env.local). Without this,
 * every page request 307-redirects to the OAuth authorize endpoint and the test
 * never reaches the classroom.
 */
function makeSessionCookieValue(): string {
  // Mirror getSessionSecret() (lib/server/session-cookie.ts) exactly so the
  // signed cookie is accepted whether or not ACCESS_CODE is configured.
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

/**
 * Regression for the "classroom stuck on Loading forever" bug.
 *
 * runClassroomLoad used to only clear the loading state in a finally block that
 * ran when the whole await-chain settled. A hung sub-step (Web Lock, IndexedDB,
 * network) or a silent "no data anywhere" result left the page spinning on
 * "Loading classroom..." with no error and no way to recover. The load now has a
 * timeout safety net and fails loud with a retryable error when neither IndexedDB
 * nor server-side storage yields a stage.
 *
 * This spec exercises both the "no data anywhere" path (fresh browser = empty
 * IndexedDB, mocked 500 = server fallback fails) and the server-fallback
 * success path (empty IndexedDB, API returns valid classroom data).
 */
test.describe('Classroom load failure', () => {
  const MISSING_CLASSROOM_ID = 'e2e-missing-classroom';
  const FALLBACK_CLASSROOM_ID = 'e2e-fallback-classroom';

  test('shows a retryable error instead of infinite loading when the classroom has no data', async ({
    page,
  }) => {
    // Admit the fresh browser past the OAuth proxy middleware (no real login).
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

    // Bypass the client-side access-code gate so the AccessCodeModal does not
    // overlay the page and block it.
    await page.route('**/api/access-code/status', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, authenticated: true }),
      }),
    );

    // Fresh browser context: no IndexedDB data exists for this classroom.
    // Force the server-side fallback to fail as well so both data sources are
    // empty — the page must surface a clear, retryable error rather than
    // spinning on "Loading classroom..." forever.
    await page.route(/\/api\/classroom\?/, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false }),
      }),
    );

    await page.goto(`/classroom/${MISSING_CLASSROOM_ID}`);

    // The loading indicator must disappear (the load terminates)...
    await expect(page.getByText('Loading classroom...')).toBeHidden({ timeout: 15_000 });

    // ...and a clear error with a Retry action is shown instead of a blank stage.
    await expect(page.getByText(/no loadable data/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('loads classroom from server fallback when IndexedDB is empty but API returns data', async ({
    page,
  }) => {
    // Admit the fresh browser past the OAuth proxy middleware.
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

    // Bypass the client-side access-code gate.
    await page.route('**/api/access-code/status', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, authenticated: true }),
      }),
    );

    // Mock a valid classroom API response so the server fallback succeeds.
    // Fresh browser context has no IndexedDB, so the API is the only source.
    await page.route(/\/api\/classroom\?/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          classroom: {
            stage: {
              id: FALLBACK_CLASSROOM_ID,
              name: 'E2E Fallback Course',
              description: '',
              style: 'professional',
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            scenes: [
              {
                id: 'e2e-fallback-scene-1',
                stageId: FALLBACK_CLASSROOM_ID,
                type: 'slide',
                title: 'Welcome',
                order: 1,
                content: {
                  type: 'slide',
                  canvas: {
                    id: 'e2e-slide-1',
                    viewportSize: 1000,
                    viewportRatio: 0.5625,
                    elements: [
                      {
                        id: 'e2e-title-el',
                        type: 'text',
                        text: 'Hello from fallback',
                        width: 400,
                        height: 60,
                        x: 100,
                        y: 200,
                        fontSize: 32,
                      },
                    ],
                  },
                },
                actions: [],
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ],
          },
        }),
      }),
    );

    await page.goto(`/classroom/${FALLBACK_CLASSROOM_ID}`);

    // The loading indicator must disappear.
    await expect(page.getByText('Loading classroom...')).toBeHidden({ timeout: 15_000 });

    // The classroom should load successfully — no error shown.
    await expect(page.getByText(/no loadable data/i)).toBeHidden();

    // The stage should render — verify the fallback scene content appears.
    await expect(page.getByText('Hello from fallback')).toBeVisible({ timeout: 10_000 });
  });
});
