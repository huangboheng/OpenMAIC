import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/scene-content';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 与服务端 getSessionSecret() 保持一致的密钥解析：
 * OPENMAIC_SESSION_SECRET || ACCESS_CODE || 'openmaic-dev-session-secret'。
 * 服务端的这些变量由 Next.js 从 .env.local 注入 process.env，而 Playwright
 * 进程不会加载 .env.local，故直接读取相同文件以保持同步。
 */
function resolveSessionSecret(): string {
  if (process.env.OPENMAIC_SESSION_SECRET) return process.env.OPENMAIC_SESSION_SECRET;
  if (process.env.ACCESS_CODE) return process.env.ACCESS_CODE;
  for (const file of ['.env.local', '.env']) {
    const p = path.join(process.cwd(), file);
    if (!existsSync(p)) continue;
    const content = readFileSync(p, 'utf-8');
    for (const key of ['OPENMAIC_SESSION_SECRET', 'ACCESS_CODE']) {
      const m = content.match(new RegExp(`^${key}=(.+)$`, 'm'));
      if (m?.[1]?.trim()) return m[1].trim();
    }
  }
  return 'openmaic-dev-session-secret';
}

/**
 * 构造签名有效的 openmaic_session cookie，让 OAuth 代理中间件（proxy.ts）
 * 放行 E2E 浏览器（无需真实登录）。否则所有页面请求都会 307 重定向到
 * OAuth authorize 端点，测试无法进入课堂。
 */
function makeSessionCookieValue(): string {
  const secret = resolveSessionSecret();
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

/** 绕过 OAuth 中间件与客户端访问码门控，须在首次导航前调用。 */
async function bypassAuth(page: import('@playwright/test').Page) {
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
  // 客户端访问码门控：报告已认证，避免 AccessCodeModal 遮挡页面。
  await page.route('**/api/access-code/status', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, authenticated: true }),
    }),
  );
}

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

// 全新安装：无任何客户端 TTS 配置，autoConfigApplied=false。
// 依赖服务端托管的 minimax-tts（mock /api/server-providers）自动选中并启用。
const SERVER_MANAGED_SETTINGS = createSettingsStorage({
  sidebarCollapsed: false,
  autoConfigApplied: false,
});

/** 种子一个含 2 条 speech 的场景的课堂（重生成才有目标）。 */
async function seedDatabase(
  page: import('@playwright/test').Page,
  settings: string = SETTINGS_STORAGE,
) {
  // 先绕过 OAuth 中间件，否则 goto('/') 会被 307 到登录端点。
  await bypassAuth(page);

  await page.addInitScript((settings) => {
    localStorage.setItem('settings-storage', settings);
    localStorage.setItem('locale', 'en-US');
  }, settings);

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

/** mock 服务端托管 minimax-tts（覆盖 base fixture 的空 server-providers）。 */
async function mockServerManagedTts(page: import('@playwright/test').Page) {
  await page.route('**/api/server-providers', (route) => {
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providers: {},
        tts: { 'minimax-tts': {} },
        asr: {},
        pdf: {},
        image: {},
        video: {},
        webSearch: {},
      }),
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
    // 服务端托管 minimax-tts，确保声音选择器有可选项（客户端配置路径在
    // E2E 环境下 hydration 不稳定，服务端托管路径可靠）。
    await mockServerManagedTts(page);
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

test.describe('Mentor Voice Switching — server-managed provider', () => {
  // 全新安装（无客户端 TTS 配置）+ 服务端托管 minimax-tts。
  // 验证声音选择器不再只显示 "default"，而是自动选中服务端 provider 并列出全部音色。

  test('服务端托管 provider：pill 显示真实音色且弹层列出可选项', async ({ page }) => {
    // 先注册路由再导航，确保首次 fetchServerProviders 即命中托管配置。
    await mockServerManagedTts(page);
    await seedDatabase(page, SERVER_MANAGED_SETTINGS);

    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    const voiceButton = page.getByRole('button', { name: 'Mentor Voice' });
    await expect(voiceButton).toBeVisible({ timeout: 10_000 });

    // 服务端同步后自动选中 minimax 默认音色（御姐音色），而非 stale 的 "default"。
    await expect(voiceButton).toContainText('御姐音色', { timeout: 10_000 });
    await expect(voiceButton).not.toContainText('default');

    // 弹层列出 minimax 全部音色，可自由选择。
    await voiceButton.click();
    await expect(page.getByRole('button', { name: '精英青年', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: '少女音色', exact: true }).first()).toBeVisible();
  });

  test('服务端托管 provider：切换音色闭环（确认 → 重生成 → 完成 toast）', async ({ page }) => {
    await mockServerManagedTts(page);
    await mockTtsSuccess(page);
    await seedDatabase(page, SERVER_MANAGED_SETTINGS);

    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    await openVoicePickerAndSelect(page);
    await page.getByRole('button', { name: 'Switch', exact: true }).click();

    await expect(page.getByText('Mentor voice fully updated')).toBeVisible({ timeout: 20_000 });
  });
});
