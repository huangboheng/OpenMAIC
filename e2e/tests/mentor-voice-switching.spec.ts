import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/scene-content';

/**
 * 导师声音切换 E2E（课堂内按钮 + 重生成闭环）。
 *
 * 覆盖：
 * 1. 成功路径：点声音按钮 → 选音色 → 确认弹层 → 确认 → 进度态 → 完成 toast。
 * 2. 失败路径：TTS 接口失败 → 错误 toast + 重试入口。
 *
 * TTS 接口使用 page.route() mock，不依赖真实 API。
 */

const TEST_STAGE_ID = 'e2e-voice-stage';

// 预置 minimax-tts 为已启用 provider（客户端 apiKey），声音选择器才有可选项。
const SETTINGS_STORAGE = createSettingsStorage({
  sidebarCollapsed: false,
  ttsProviderId: 'minimax-tts',
  ttsVoice: 'female-yujie',
  ttsProvidersConfig: {
    'minimax-tts': { enabled: true, apiKey: 'test-key' },
  },
});

/** 种子一个含 2 条 speech 的场景的课堂（重生成才有目标）。 */
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
            name: 'Voice Test',
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
            actions: [
              { id: 'speech-1', type: 'speech', text: 'Hello world.' },
              { id: 'speech-2', type: 'speech', text: 'Second line.' },
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
        request.onerror = () => reject(request.error);
      });
    },
    { stageId: TEST_STAGE_ID, theme: defaultTheme },
  );
}

/** mock TTS 成功（带小延迟，便于观察进度态）。 */
async function mockTtsSuccess(page: import('@playwright/test').Page) {
  await page.route('**/api/generate/tts', async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        base64: btoa('fake-audio-bytes'),
        format: 'mp3',
        audioId: 'mock-audio',
      }),
    });
  });
}

/** mock TTS 失败（400 不可重试，快速失败）。 */
async function mockTtsFailure(page: import('@playwright/test').Page) {
  await page.route('**/api/generate/tts', async (route) => {
    await route.fulfill({
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'TTS provider error' }),
    });
  });
}

/** 打开声音弹层并选定一个音色，触发确认弹层。 */
async function openVoicePickerAndSelect(page: import('@playwright/test').Page) {
  const voiceButton = page.getByRole('button', { name: 'Mentor Voice' });
  await expect(voiceButton).toBeVisible({ timeout: 10_000 });
  await voiceButton.click();
  // minimax 音色名为常量（中文），与界面语言无关。
  await page.getByRole('button', { name: '精英青年', exact: true }).first().click();
}

test.describe('Mentor Voice Switching', () => {
  test.beforeEach(async ({ page }) => {
    await seedDatabase(page);
  });

  test('成功路径：确认弹层 → 进度态 → 完成 toast', async ({ page }) => {
    await mockTtsSuccess(page);
    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    await openVoicePickerAndSelect(page);

    // 切换前确认弹层：明确告知将重新生成全部讲课音频
    await expect(page.getByText('Switch Mentor Voice')).toBeVisible();
    await expect(page.getByText(/regenerate all lecture audio/i)).toBeVisible();

    // 确认后进入重生成，显示进度
    await page.getByRole('button', { name: 'Switch', exact: true }).click();
    await expect(page.getByText(/Regenerating mentor voice/i)).toBeVisible({ timeout: 10_000 });

    // 全部完成后成功 toast
    await expect(page.getByText('Mentor voice fully updated')).toBeVisible({ timeout: 20_000 });
  });

  test('失败路径：错误 toast + 重试入口', async ({ page }) => {
    await mockTtsFailure(page);
    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    await openVoicePickerAndSelect(page);
    await page.getByRole('button', { name: 'Switch', exact: true }).click();

    // 失败不静默：错误 toast + 重试按钮
    await expect(page.getByText(/failed to generate/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});
