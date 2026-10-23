import { test, expect } from '@playwright/test';

// The webServer in playwright.config.ts sets the same ACCESS_CODE.
const ACCESS_CODE = process.env.ACCESS_CODE;

test.describe('standalone access-code gate', () => {
  test.skip(!ACCESS_CODE, 'ACCESS_CODE is required for the access-code gate test');

  // The first request on a cold dev server compiles the page and the client-side
  // status request; this machine's slow filesystem can exceed the default 5s.
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    page.setDefaultNavigationTimeout(120_000);
  });

  test('requires the access code, then unlocks the app', async ({ page }) => {
    await page.goto('/');

    const codeInput = page.locator('input[type="password"]');
    await expect(codeInput).toBeVisible({ timeout: 30_000 });

    await codeInput.fill('wrong-access-code');
    await codeInput.press('Enter');
    await expect(codeInput).toBeVisible();
    await expect(codeInput).toHaveValue('');

    await codeInput.fill(ACCESS_CODE!);
    await codeInput.press('Enter');
    await expect(codeInput).toBeHidden({ timeout: 15_000 });

    const cookies = await page.context().cookies();
    expect(cookies.find((cookie) => cookie.name === 'openmaic_access')?.value).toBeTruthy();
    await expect(page.locator('textarea').first()).toBeVisible();

    const statusResponse = page.waitForResponse((response) =>
      response.url().includes('/api/access-code/status'),
    );
    await page.reload();
    await statusResponse;
    await expect(page.locator('textarea').first()).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  });

  test('renders unauthenticated subpages instead of redirecting to OAuth', async ({ page }) => {
    await page.goto('/generation-preview');

    await expect(page.locator('input[type="password"]')).toBeVisible({ timeout: 30_000 });

    const baseURL = test.info().project.use.baseURL;
    expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
  });
});
