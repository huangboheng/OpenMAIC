import { defineConfig, devices } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

// E2E auth bypass signs the `openmaic_session` cookie inside the TEST process
// (see makeSessionCookieValue in e2e/tests/*.spec.ts). The dev server resolves
// its session secret via getSessionSecret(): OPENMAIC_SESSION_SECRET ||
// ACCESS_CODE || fallback — with ACCESS_CODE coming from .env.local, which the
// Playwright runner never loads. The mismatch silently fails cookie
// verification, and every navigation then 307s to OAUTH_ISSUER (a port nothing
// listens on in e2e) → net::ERR_CONNECTION_REFUSED. Mirror the two secret
// sources from .env.local here so both sides agree.
function loadDotEnvSecrets(): void {
  if (!existsSync('.env.local')) return;
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = /^(OPENMAIC_SESSION_SECRET|ACCESS_CODE)=(.*)$/.exec(line.trim());
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
loadDotEnvSecrets();


export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  // Dev-mode cold compilation (first request compiles the whole page) can
  // exceed the default 30s on slow machines; keep a wider ceiling.
  timeout: 60_000,
  reporter: process.env.CI ? 'html' : 'list',
  use: {
    baseURL: 'http://localhost:3002',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: process.env.CI ? 'pnpm build && pnpm start' : 'pnpm dev',
    url: 'http://localhost:3002/favicon.ico',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Enable the MAIC Editor (Pro mode) so editor e2e can reach it.
    // These are build-time NEXT_PUBLIC_* flags, so they must be set when the
    // webServer runs `pnpm build` (CI) or `pnpm dev` (local).
    //
    // NEXT_PUBLIC_BASE_PATH is forced empty so the e2e dev server is NOT
    // mounted under /openmaic (the value .env.local uses for the Philochora
    // reverse-proxy deployment). Tests navigate bare paths (/classroom/:id,
    // /favicon.ico probe); a basePath would 404 every navigation. A real
    // process env value (even '') takes precedence over .env.local.
    //
    // NODE_ENV must stay 'development': the Playwright runner injects
    // NODE_ENV=test into the webServer process, which is never the intent for
    // a dev server under test. (An earlier crash blamed Turbopack testMode;
    // the real root cause was the session-secret mismatch above.)
    env: {
      NODE_ENV: 'development',
      PORT: '3002',
      NEXT_PUBLIC_MAIC_EDITOR_ENABLED: 'true',
      NEXT_PUBLIC_BASE_PATH: '',
    },
  },
});
