import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { createHmac } from 'node:crypto';

/**
 * 回归测试：仅持 OAuth 会话（openmaic_session）的用户不应被访问码门控拦截。
 *
 * 根因：access-code/status 端点此前仅认 openmaic_access（无缝认证 token），
 * 不认 OAuth 会话。中间件（proxy.ts）对两者取"或"放行，导致仅持 OAuth 会话
 * 的用户页面可加载（200）但 AccessCodeModal（z-200 全屏遮罩）拦截一切指针
 * 事件——课堂内所有互动 widget（含哲学游戏）"加载后无法交互"。
 *
 * 本测试只注入 openmaic_session（不注入 openmaic_access），且不 mock
 * access-code/status（走真实端点），断言互动 widget 可正常交互。
 */

function makeSessionCookieValue(): string {
  const secret = process.env.ACCESS_CODE || 'philochora-openmaic-2026';
  const data = {
    sub: 'e2e-oauth-user',
    name: 'E2E OAuth User',
    picture: '',
    access_token: 'e2e-access-token',
    refresh_token: 'e2e-refresh-token',
    expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

const TEST_STAGE_ID = 'e2e-oauth-access-gate';
const INTERACTIVE_SCENE_ID = 'scene-oauth-gate-widget';
const IFRAME_TITLE = `Interactive Scene ${INTERACTIVE_SCENE_ID}`;
const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/** 简单的可交互 widget（计数器按钮），用于验证互动管线在真实访问门控下可用。 */
const INTERACTIVE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#eaf0ff">
  <div style="text-align:center">
    <div style="font-size:14px;color:#556">interactive widget</div>
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
          name: 'OAuth access gate test',
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
          title: '互动组件',
          order: 0,
          content: { type: 'interactive', url: '', html },
          createdAt: now,
          updatedAt: now,
        });
        tx.objectStore('stageOutlines').put({ stageId, outlines: [], createdAt: now, updatedAt: now });
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

test.describe('OAuth 会话用户不被访问码门控拦截', () => {
  test('仅 openmaic_session 时互动 widget 可正常交互', async ({ page }) => {
    // 只注入 OAuth 会话 cookie，不注入 openmaic_access
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
    // 注意：不 mock /api/access-code/status，走真实端点验证修复

    await seedDatabase(page);

    const classroomPage = new ClassroomPage(page);
    await classroomPage.goto(TEST_STAGE_ID);
    await classroomPage.waitForLoaded();

    // 访问码弹窗不应出现（修复前它会全屏拦截一切指针事件）
    const accessModal = page.locator('input[type="password"]');
    await expect(accessModal).toHaveCount(0);

    const iframeEl = page.locator(`iframe[title="${IFRAME_TITLE}"]`);
    const frame = page.frameLocator(`iframe[title="${IFRAME_TITLE}"]`);

    await expect(iframeEl).toBeVisible({ timeout: 15_000 });
    await expect(frame.locator('#count')).toHaveText('0', { timeout: 15_000 });

    // 遮挡检查：iframe 中心最顶层元素应为 iframe 本身（无遮罩）
    const box = await iframeEl.boundingBox();
    expect(box).not.toBeNull();
    const topTag = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'null',
      [box!.x + box!.width / 2, box!.y + box!.height / 2] as [number, number],
    );
    expect(topTag).toBe('IFRAME');

    // widget 可交互：点击 +1 两次，计数应递增
    await frame.locator('#inc').click();
    await frame.locator('#inc').click();
    await expect(frame.locator('#count')).toHaveText('2');
  });
});
