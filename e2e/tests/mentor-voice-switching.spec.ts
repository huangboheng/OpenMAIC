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
 * 导师声音切换 E2E（预生成多音色瞬时切换架构）。
 *
 * 课堂生成时已为每个 speech action 预生成全部音色的音频，切换音色仅更新
 * store 中的 ttsVoice，播放引擎在下次 play() 调用时自动解析到对应音频：
 * - audioUrl 路径：{voice} 模板替换为当前音色文件名；
 * - IndexedDB 路径：audioId 的默认音色后缀替换为当前音色后缀。
 *
 * 覆盖：
 * 1. 瞬时切换：选择音色后 pill 立即更新，无确认弹层、无等待。
 * 2. 播放中切换：当前句立即以新音色重播（音频请求 URL 含新音色文件名）。
 * 3. 服务端托管 provider：pill 显示真实音色、弹层列出全部可选项。
 * 4. 声音切换按钮始终可用（试看机制已移除的回归断言）。
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

/** 生成一段静音 WAV（8kHz mono 8-bit），供音频路由 mock 返回。 */
function makeSilentWav(seconds = 10): Buffer {
  const sampleRate = 8000;
  const dataSize = sampleRate * seconds;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate, 28); // byte rate
  buf.writeUInt16LE(1, 32); // block align
  buf.writeUInt16LE(8, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  buf.fill(0x80, 44); // 8-bit unsigned silence
  return buf;
}

/**
 * 种子一个含 2 条 speech 的场景的课堂。
 * audioUrl 使用 {voice} 模板（与服务端预生成管线一致），播放时按当前音色解析。
 */
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
              {
                id: 'speech-1',
                type: 'speech',
                text: 'Hello world.',
                audioId: 'tts_s0_speech-1_female-yujie',
                audioUrl: 'http://localhost:3002/audio-test/tts_s0_speech-1_{voice}.mp3',
              },
              {
                id: 'speech-2',
                type: 'speech',
                text: 'Second line.',
                audioId: 'tts_s0_speech-2_female-yujie',
                audioUrl: 'http://localhost:3002/audio-test/tts_s0_speech-2_{voice}.mp3',
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
    },
    { stageId: TEST_STAGE_ID, theme: defaultTheme },
  );
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

/** 打开声音弹层并选定一个音色（瞬时切换，无确认步骤）。 */
async function openVoicePickerAndSelect(page: import('@playwright/test').Page) {
  const voiceButton = page.getByRole('button', { name: 'Mentor Voice' });
  await expect(voiceButton).toBeVisible({ timeout: 10_000 });
  await voiceButton.click();
  // minimax 音色名为常量（中文），与界面语言无关。按钮可访问名含性别符号
  // （如 "精英青年♂"），故用正则部分匹配。
  await page.getByRole('button', { name: /精英青年/ }).first().click();
}

test.describe('Mentor Voice Switching — instant switch', () => {
  test.beforeEach(async ({ page }) => {
    await mockServerManagedTts(page);
    await seedDatabase(page);
  });

  test('选择音色后 pill 立即更新，无确认弹层', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    const voiceButton = page.getByRole('button', { name: 'Mentor Voice' });
    await expect(voiceButton).toContainText('御姐音色', { timeout: 10_000 });

    await openVoicePickerAndSelect(page);

    // 瞬时切换：pill 立即显示新音色，无确认弹层、无进度、无 toast
    await expect(voiceButton).toContainText('精英青年');
    await expect(page.getByText('Switch Mentor Voice')).not.toBeVisible();
    await expect(page.getByText(/Regenerating/i)).not.toBeVisible();
  });

  test('播放中切换音色：当前句立即以新音色重播（音频请求验证）', async ({ page }) => {
    // 记录音频请求 URL（{voice} 模板解析后的真实路径）
    const audioRequests: string[] = [];
    await page.route('**/audio-test/**', (route) => {
      audioRequests.push(route.request().url());
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
        body: makeSilentWav(10),
      });
    });

    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    // 启动播放
    await page.getByRole('button', { name: 'Play', exact: true }).click();

    // 等待第一句音频以默认音色（female-yujie）请求
    await expect.poll(() => audioRequests.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    expect(audioRequests[0]).toContain('tts_s0_speech-1_female-yujie');

    // 播放中途切换音色（force: 播放中浮动层可能短暂遮挡头部按钮）
    const voiceButton = page.getByRole('button', { name: 'Mentor Voice' });
    await voiceButton.click({ force: true });
    await page.getByRole('button', { name: /精英青年/ }).first().click({ force: true });

    // 核心断言：当前句立即以新音色重新请求音频（无需手动刷新页面）
    await expect
      .poll(() => audioRequests.some((url) => url.includes('male-qn-jingying')), {
        timeout: 10_000,
      })
      .toBe(true);
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

    // 服务端同步后自动选中 minimax 默认音色（御姐音色 = DEFAULT_TTS_VOICES），
    // 而非 stale 的 "default"。
    await expect(voiceButton).toContainText('御姐音色', { timeout: 10_000 });
    await expect(voiceButton).not.toContainText('default');

    // 弹层列出 minimax 全部音色，可自由选择。
    await voiceButton.click();
    await expect(page.getByRole('button', { name: /精英青年/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /少女音色/ }).first()).toBeVisible();
  });

  test('服务端托管 provider：切换音色即时生效（pill 立即更新）', async ({ page }) => {
    await mockServerManagedTts(page);
    await seedDatabase(page, SERVER_MANAGED_SETTINGS);

    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    const voiceButton = page.getByRole('button', { name: 'Mentor Voice' });
    await expect(voiceButton).toBeVisible({ timeout: 10_000 });
    await expect(voiceButton).toContainText('御姐音色', { timeout: 10_000 });

    // 切换到少女音色 — 瞬时生效
    await voiceButton.click();
    await page.getByRole('button', { name: /少女音色/ }).first().click();
    await expect(voiceButton).toContainText('少女音色');
  });
});

test.describe('Mentor Voice Switching — 切换可用性回归', () => {
  // 背景：曾因试看模式（isTrial=true）禁用声音切换按钮导致用户永远无法切换；
  // 试看机制已移除（BR：禁用 10 分钟试看），本用例回归断言按钮始终可用。

  test('声音切换按钮可用且瞬时生效', async ({ page }) => {
    await mockServerManagedTts(page);
    await seedDatabase(page);

    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    // 声音按钮不应被禁用
    const voiceButton = page.getByRole('button', { name: 'Mentor Voice' });
    await expect(voiceButton).toBeVisible({ timeout: 10_000 });
    await expect(voiceButton).toBeEnabled();

    // 弹层可打开，音色可选择
    await voiceButton.click();
    await expect(page.getByRole('button', { name: /精英青年/ }).first()).toBeVisible();

    // 瞬时切换闭环：选择 → pill 立即更新
    await page.getByRole('button', { name: /精英青年/ }).first().click();
    await expect(voiceButton).toContainText('精英青年');
  });
});
