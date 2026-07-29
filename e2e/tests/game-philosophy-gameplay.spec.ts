import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * 哲学互动游戏「与AI哲学家对话」完整游玩旅程 E2E：
 * 加载真实游戏 → 点击"开始游戏" → 拖拽卡牌到辩论目标 → 验证 HP/分数变化。
 *
 * 游戏 HTML 取自教室 4b8tbcW5gC 的游戏场景（已固化为 fixture，自包含、可移植）。
 * 游戏为纯前端 HTML（不调用 AI 接口），无需 mock LLM；仅按惯例注入认证 cookie。
 */

function makeSessionCookieValue(): string {
  const secret = process.env.ACCESS_CODE || 'philochora-openmaic-2026';
  const data = {
    sub: 'e2e-gamer',
    name: 'E2E Gamer',
    picture: '',
    access_token: 'e2e-access-token',
    refresh_token: 'e2e-refresh-token',
    expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function makeAccessTokenValue(): string {
  const secret = process.env.ACCESS_CODE || 'philochora-openmaic-2026';
  const timestamp = Date.now().toString();
  const signature = createHmac('sha256', secret).update(timestamp).digest('hex');
  return `${timestamp}.${signature}`;
}

const TEST_STAGE_ID = 'e2e-philosophy-game';
const GAME_SCENE_ID = 'scene-philosophy-debate';
const IFRAME_TITLE = `Interactive Scene ${GAME_SCENE_ID}`;
const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

const GAME_HTML = readFileSync(
  path.join(__dirname, '../fixtures/game-philosophy-debate.html'),
  'utf-8',
);

async function seedDatabase(page: import('@playwright/test').Page) {
  await page.addInitScript((settings) => {
    localStorage.setItem('settings-storage', settings);
  }, SETTINGS_STORAGE);

  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(({ stageId, sceneId, html }) => {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('MAIC-Database');
      request.onsuccess = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const tx = db.transaction(['stages', 'scenes', 'stageOutlines'], 'readwrite');
        const now = Date.now();
        tx.objectStore('stages').put({
          id: stageId,
          name: '哲学游戏旅程测试',
          description: '',
          language: 'zh-CN',
          style: 'interactive',
          currentSceneId: sceneId,
          createdAt: now,
          updatedAt: now,
        });
        tx.objectStore('scenes').put({
          id: sceneId,
          stageId,
          type: 'interactive',
          title: '与AI哲学家对话',
          order: 0,
          content: { type: 'interactive', url: '', html, widgetType: 'game' },
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
  }, { stageId: TEST_STAGE_ID, sceneId: GAME_SCENE_ID, html: GAME_HTML });
}

test.describe('哲学互动游戏完整游玩旅程', () => {
  test('开始游戏 → 拖拽卡牌 → HP/分数变化', async ({ page }) => {
    await page.context().addCookies([
      {
        name: 'openmaic_session',
        value: makeSessionCookieValue(),
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
      {
        name: 'openmaic_access',
        value: makeAccessTokenValue(),
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    await seedDatabase(page);

    const classroomPage = new ClassroomPage(page);
    await classroomPage.goto(TEST_STAGE_ID);
    await classroomPage.waitForLoaded();

    const iframeEl = page.locator(`iframe[title="${IFRAME_TITLE}"]`);
    const frame = page.frameLocator(`iframe[title="${IFRAME_TITLE}"]`);

    await expect(iframeEl).toBeVisible({ timeout: 15_000 });
    await expect(frame.locator('#overlay-start')).toBeVisible({ timeout: 15_000 });

    // ── 1. 点击"开始游戏" ──
    await frame.locator('#overlay-start button', { hasText: '开始' }).first().click({ timeout: 5_000 });
    await page.waitForTimeout(1_200);

    // 开始层应透明且不拦截指针，手牌应发出 5 张
    const startState = await frame.locator('#overlay-start').evaluate((el) => ({
      opacity: getComputedStyle(el).opacity,
      pointerEvents: getComputedStyle(el).pointerEvents,
      cardCount: document.querySelectorAll('.card').length,
    }));
    expect(startState.opacity).toBe('0');
    expect(startState.pointerEvents).toBe('none');
    expect(startState.cardCount).toBe(5);

    // ── 2. 记录初始 HP / 分数 ──
    const readStats = () =>
      frame.locator('#game-container').evaluate(() => ({
        oppHP: parseInt(document.getElementById('opp-hp-text')?.textContent ?? '100', 10),
        playerHP: parseInt(document.getElementById('player-hp-text')?.textContent ?? '100', 10),
        score: parseInt(document.getElementById('score-val')?.textContent ?? '0', 10),
      }));
    const before = await readStats();
    expect(before.oppHP).toBe(100);
    expect(before.playerHP).toBe(100);

    // ── 3. 拖拽第一张卡牌到辩论目标 ──
    const cardBox = await frame.locator('.card').first().boundingBox();
    const targetBox = await frame.locator('#debate-target').boundingBox();
    expect(cardBox).not.toBeNull();
    expect(targetBox).not.toBeNull();

    await page.mouse.move(cardBox!.x + cardBox!.width / 2, cardBox!.y + cardBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
    await page.waitForTimeout(1_200);

    // ── 4. 验证卡牌结算：HP 或分数至少一项发生变化 ──
    const after = await readStats();
    const changed =
      after.oppHP !== before.oppHP ||
      after.playerHP !== before.playerHP ||
      after.score !== before.score;
    expect(changed, `拖拽卡牌后应有结算变化，before=${JSON.stringify(before)} after=${JSON.stringify(after)}`).toBe(true);
  });
});
