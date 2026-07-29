import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { createHmac } from 'node:crypto';

/**
 * Build a valid signed `openmaic_session` cookie so the OAuth proxy middleware
 * (proxy.ts) admits the fresh E2E browser without a real Philochora login. The
 * secret mirrors getSessionSecret() (ACCESS_CODE from .env.local). Without this,
 * every page request 307-redirects to the OAuth authorize endpoint and the test
 * never reaches the classroom.
 */
function makeSessionCookieValue(): string {
  const secret = process.env.ACCESS_CODE || 'philochora-openmaic-2026';
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
 * E2E for the "thought experiment" (思想实验) interactive widgets.
 *
 * Every generated widget embeds a KaTeX loader from cdn.jsdelivr.net. Historically
 * it was injected as render-blocking <link>/<script src> tags in <head>, so when
 * the CDN was slow or unreachable the classic scripts stalled <body> parsing and
 * the iframe stayed blank — the thought-experiment game (which never renders math)
 * was unusable. The loader is now rewritten to a non-blocking dynamic load at
 * render time (lib/utils/iframe.ts).
 *
 * This spec simulates an UNREACHABLE CDN by leaving every jsdelivr request pending
 * (never fulfilled/aborted) and asserts the widget still renders and is fully
 * interactive. Before the fix the blocking scripts hang parsing and the counter
 * below never appears; after the fix it renders immediately.
 */

const TEST_STAGE_ID = 'e2e-thought-experiment-cdn';
const INTERACTIVE_SCENE_ID = 'scene-thought-exp';
const IFRAME_TITLE = `Interactive Scene ${INTERACTIVE_SCENE_ID}`;

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/** Widget carrying the exact render-blocking KaTeX loader the generator emitted
 *  before the hardening, plus a click counter to prove interactivity. */
const INTERACTIVE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
<script>
document.addEventListener("DOMContentLoaded", function() { renderMathInElement(document.body, {}); });
</script>
</head>
<body style="margin:0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#eaf0ff">
  <div style="text-align:center">
    <div style="font-size:14px;color:#556">thought experiment widget</div>
    <h1 id="count" style="font-size:72px;margin:8px 0;color:#2a3">0</h1>
    <button id="inc" style="font-size:18px;padding:8px 18px">+1</button>
  </div>
  <script>
    var n = 0, c = document.getElementById('count');
    document.getElementById('inc').addEventListener('click', function () { c.textContent = String(++n); });
  </script>
</body></html>`;

async function seedDatabase(page: import('@playwright/test').Page) {
  await page.addInitScript((settings) => {
    localStorage.setItem('settings-storage', settings);
  }, SETTINGS_STORAGE);

  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(({ stageId, interactiveId, html }) => {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('MAIC-Database');
      request.onsuccess = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const tx = db.transaction(['stages', 'scenes', 'stageOutlines'], 'readwrite');
        const now = Date.now();

        tx.objectStore('stages').put({
          id: stageId,
          name: 'Thought experiment CDN test',
          description: '',
          language: 'zh-CN',
          style: 'professional',
          currentSceneId: interactiveId,
          createdAt: now,
          updatedAt: now,
        });

        tx.objectStore('scenes').put({
          id: interactiveId,
          stageId,
          type: 'interactive',
          title: '思想实验',
          order: 0,
          content: { type: 'interactive', url: '', html },
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
      request.onerror = () => reject(request.error);
    });
  }, { stageId: TEST_STAGE_ID, interactiveId: INTERACTIVE_SCENE_ID, html: INTERACTIVE_HTML });
}

test.describe('thought experiment widget survives an unreachable KaTeX CDN', () => {
  test('renders and stays interactive while cdn.jsdelivr.net hangs', async ({ page }) => {
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

    // Bypass the client-side access-code gate: report already-authenticated so
    // the AccessCodeModal does not overlay the page and block pointer events.
    await page.route('**/api/access-code/status', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, authenticated: true }),
      }),
    );

    // Simulate a hanging CDN: intercept every jsdelivr request and never respond.
    // A pending request (no fulfill/abort) mirrors a firewall that silently drops
    // packets — the case that blanks a render-blocking script indefinitely.
    await page.route('**/cdn.jsdelivr.net/**', () => {
      // intentionally left pending
    });

    await seedDatabase(page);

    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    const iframeEl = page.locator(`iframe[title="${IFRAME_TITLE}"]`);
    const frame = page.frameLocator(`iframe[title="${IFRAME_TITLE}"]`);
    const count = frame.locator('#count');

    // The keep-alive iframe is mounted and visible…
    await expect(iframeEl).toBeVisible({ timeout: 15_000 });
    // …and its document actually rendered despite the hanging CDN (before the fix
    // the blocking scripts stall <body> parsing and this times out on a blank box).
    await expect(count).toHaveText('0', { timeout: 15_000 });

    // The widget is fully interactive.
    await frame.locator('#inc').click();
    await frame.locator('#inc').click();
    await expect(count).toHaveText('2');
  });
});
