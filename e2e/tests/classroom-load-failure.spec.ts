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

const MISSING_CLASSROOM_ID = 'e2e-missing-classroom';

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
 * This spec exercises the "no data anywhere" path (fresh browser = empty IndexedDB,
 * mocked 500 = server fallback fails) and asserts the page terminates the loading
 * state and shows a clear, retryable error instead of hanging.
 */
test.describe('Classroom load failure', () => {
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
});
