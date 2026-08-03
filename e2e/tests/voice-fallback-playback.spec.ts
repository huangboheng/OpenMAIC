import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/scene-content';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 缺失音色文件的播放回退 E2E。
 *
 * 存量课堂可能缺失部分预生成音色文件（历史生成失败），audioUrl 的 {voice}
 * 模板会解析到不存在的文件。修复后的 AudioPlayer 回退链：
 * 当前音色 URL → 默认音色 URL → IndexedDB → 读秒计时（不再静默卡死）。
 *
 * 场景：同步后默认音色为 female-yujie；先切换到 male-qn-jingying（其文件
 * 在 mock 中 404），播放时验证回退到 female-yujie 文件并继续播放。
 */

const TEST_STAGE_ID = 'e2e-voice-fallback-stage';

// 与 mentor-voice-switching 一致：预置 minimax-tts 客户端配置；
// ttsEnabled 由 server-managed mock 触发的首次同步自动开启。
const SETTINGS_STORAGE = createSettingsStorage({
  sidebarCollapsed: false,
  ttsProviderId: 'minimax-tts',
  ttsVoice: 'female-yujie',
  ttsProvidersConfig: {
    'minimax-tts': { enabled: true, apiKey: 'test-key' },
  },
});

/** 与服务端 getSessionSecret() 一致的密钥解析（同 mentor-voice-switching）。 */
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
  await page.route('**/api/access-code/status', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, authenticated: true }),
    }),
  );
}

/** 生成一段短静音 WAV（8kHz mono 8-bit），供音频路由 mock 返回。 */
function makeSilentWav(seconds = 2): Buffer {
  const sampleRate = 8000;
  const dataSize = sampleRate * seconds;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  buf.fill(0x80, 44);
  return buf;
}

/**
 * 种子课堂：speech-1 的 {voice} 模板中 male-qn-jingying 缺失（404）、
 * female-yujie 存在；speech-2 只有 female-yujie 存在。
 */
async function seedDatabase(page: import('@playwright/test').Page) {
  await bypassAuth(page);

  await page.addInitScript((settings) => {
    localStorage.setItem('settings-storage', settings);
    localStorage.setItem('locale', 'en-US');
  }, SETTINGS_STORAGE);

  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(
    ({ stageId, theme }) => {
      return new Promise<void>((resolve, reject) => {
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
            name: 'Voice Fallback Test',
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

/**
 * 音频路由 mock：male-qn-jingying 音色文件一律 404（模拟缺失的预生成文件），
 * 其余音色返回静音 WAV。记录全部请求 URL 用于断言回退顺序。
 */
async function mockAudioRoutes(
  page: import('@playwright/test').Page,
  audioRequests: string[],
) {
  await page.route('**/audio-test/**', (route) => {
    const url = route.request().url();
    audioRequests.push(url);
    if (url.includes('male-qn-jingying')) {
      return route.fulfill({ status: 404, body: 'Not Found' });
    }
    return route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'audio/wav' },
      body: makeSilentWav(2),
    });
  });
}

/** mock 服务端托管 minimax-tts（触发首次同步自动开启 ttsEnabled）。 */
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

/** 打开声音弹层并选定精英青年（male-qn-jingying，其文件 mock 为 404）。 */
async function switchToMissingVoice(page: import('@playwright/test').Page) {
  const voiceButton = page.getByRole('button', { name: 'Mentor Voice' });
  await expect(voiceButton).toBeVisible({ timeout: 10_000 });
  await voiceButton.click();
  await page.getByRole('button', { name: /精英青年/ }).first().click();
}

test.describe('Missing pre-generated voice fallback', () => {
  test('缺失当前音色文件时回退默认音色并继续播放', async ({ page }) => {
    const audioRequests: string[] = [];
    await mockServerManagedTts(page);
    await mockAudioRoutes(page, audioRequests);
    await seedDatabase(page);

    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    // 切换到文件缺失的音色（male-qn-jingying），然后开始播放
    await switchToMissingVoice(page);
    await page.getByRole('button', { name: 'Play', exact: true }).click();

    // 1) 先请求缺失的当前音色（male-qn-jingying）→ 404
    await expect
      .poll(() => audioRequests.some((u) => u.includes('male-qn-jingying')), {
        timeout: 10_000,
      })
      .toBe(true);

    // 2) 回退请求默认音色（female-yujie）
    await expect
      .poll(() => audioRequests.filter((u) => u.includes('female-yujie')).length, {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(1);

    // 3) 回退顺序正确：缺失音色请求先于默认音色请求
    const firstMissing = audioRequests.findIndex((u) => u.includes('male-qn-jingying'));
    const firstFallback = audioRequests.findIndex((u) => u.includes('female-yujie'));
    expect(firstMissing).toBeLessThan(firstFallback);

    // 4) 播放推进到第二条语音（回退链未卡死）
    await expect
      .poll(() => audioRequests.some((u) => u.includes('tts_s0_speech-2')), {
        timeout: 30_000,
      })
      .toBe(true);
  });
});
