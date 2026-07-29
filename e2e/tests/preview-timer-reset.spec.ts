import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/scene-content';

/**
 * 试看计时器重置 回归 E2E。
 *
 * 背景：usePreviewTimer 曾把首次访问时间戳写入 localStorage 后永不重置，
 * 导致 10 分钟后 PreviewExpiredOverlay「永久」阻断整个课堂页面——导师声音
 * 切换按钮连同整页一起消失（fix: 过期后重新进入应重置为新一轮试看）。
 *
 * 覆盖：
 * 1. 过期后重新进入：计时起点被重置、无阻断层、课堂可用（声音按钮可见）。
 * 2. 首次进入：获得完整新一轮试看、无阻断、写入计时起点。
 *
 * 与 voice-switching 测试同源：种子 IndexedDB，不依赖真实 API。
 */

const TEST_STAGE_ID = 'e2e-preview-timer-stage';

const SETTINGS_STORAGE = createSettingsStorage({
  sidebarCollapsed: false,
});

/** 种子一个含单场景 slide 的课堂（可正常加载）。 */
async function seedDatabase(page: import('@playwright/test').Page) {
  await page.addInitScript((settings) => {
    localStorage.setItem('settings-storage', settings);
    localStorage.setItem('locale', 'en-US');
  }, SETTINGS_STORAGE);

  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(
    ({ stageId, theme }) => {
      return new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('MAIC-Database');
        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const tx = db.transaction(['stages', 'scenes', 'stageOutlines'], 'readwrite');
          const now = Date.now();

          tx.objectStore('stages').put({
            id: stageId,
            name: 'Preview Timer Test',
            description: '',
            language: 'en-US',
            style: 'professional',
            createdAt: now,
            updatedAt: now,
          });

          tx.objectStore('scenes').put({
            id: 'scene-0',
            stageId,
            type: 'slide',
            title: 'Intro',
            order: 0,
            content: {
              type: 'slide',
              canvas: {
                id: 'slide-0',
                viewportSize: 1000,
                viewportRatio: 0.5625,
                theme,
                elements: [
                  { type: 'text', id: 'el-0', content: 'Intro', left: 50, top: 50, width: 900, height: 100 },
                ],
              },
            },
            actions: [{ id: 'speech-1', type: 'speech', text: 'Hello world.' }],
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
    },
    { stageId: TEST_STAGE_ID, theme: defaultTheme },
  );
}

test.describe('Preview Timer Reset', () => {
  test.beforeEach(async ({ page }) => {
    await seedDatabase(page);
  });

  test('过期后重新进入：计时重置、无阻断、声音按钮可用', async ({ page }) => {
    // 模拟上一轮已过期（20 分钟前首次访问）的时间戳
    await page.evaluate((stageId) => {
      const expiredStart = Date.now() - 20 * 60 * 1000;
      localStorage.setItem(`openmaic.preview.${stageId}`, String(expiredStart));
    }, TEST_STAGE_ID);

    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    // 回归断言：过期键不得阻断课堂（旧 bug 为永久阻断）
    await expect(page.getByText('免费试看已结束')).not.toBeVisible();

    // 计时起点应被重置为本次进入的全新时间戳（最近一分钟内）
    const stored = await page.evaluate((stageId) => {
      return localStorage.getItem(`openmaic.preview.${stageId}`);
    }, TEST_STAGE_ID);
    expect(Number(stored)).toBeGreaterThan(Date.now() - 60_000);

    // 课堂可用——导师声音按钮（原报告「消失」的按钮）可见
    await expect(page.getByRole('button', { name: 'Mentor Voice' })).toBeVisible({ timeout: 10_000 });
  });

  test('首次进入：获得完整新一轮试看、无阻断', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    await expect(page.getByText('免费试看已结束')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Mentor Voice' })).toBeVisible({ timeout: 10_000 });

    // 首次进入应写入计时起点
    const stored = await page.evaluate((stageId) => {
      return localStorage.getItem(`openmaic.preview.${stageId}`);
    }, TEST_STAGE_ID);
    expect(Number(stored)).toBeGreaterThan(Date.now() - 60_000);
  });
});
