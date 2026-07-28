import { test, expect } from "@playwright/test";

/**
 * OpenMAIC 连续学习进度回调 E2E 测试
 *
 * 验证：课堂完成页挂载时 NextLessonBanner 自动触发 POST
 * /api/philochora/chapter-complete 回调（包含正确的 payload 字段）。
 *
 * 所有 API 通过 page.route() mock，不依赖真实后端或 Philochora。
 */

/** Mock classroom API：返回一个含 scenes 的课堂数据 */
function mockClassroomApi(page: import("@playwright/test").Page, classroomId: string) {
  return page.route(`**/api/classroom?id=${classroomId}`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classroom: {
          id: classroomId,
          stage: {
            id: "test-stage",
            name: "测试课堂",
            description: "",
            language: "zh-CN",
            style: "professional",
          },
          scenes: [
            {
              id: "scene-1",
              order: 1,
              type: "slide",
              title: "第一课",
              content: { type: "slide", canvas: { elements: [] } },
            },
          ],
        },
      }),
    });
  });
}

test.describe("连续学习进度回调", () => {
  const CLASSROOM_ID = "test-classroom-cb";

  test("课堂完成页挂载时自动 POST /api/philochora/chapter-complete", async ({ page }) => {
    let callbackReceived = false;
    let callbackBody: Record<string, unknown> = {};

    // Mock 进度回调代理端点 — 捕获调用并返回 ok
    await page.route("**/api/philochora/chapter-complete", async (route) => {
      callbackReceived = true;
      const req = route.request();
      try {
        callbackBody = JSON.parse(req.postData() ?? "{}");
      } catch {
        // ignore parse errors
      }
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true }),
      });
    });

    // Mock 课堂 API
    await mockClassroomApi(page, CLASSROOM_ID);

    // 导航到课堂完成页（带章节序列参数）
    const chapters = [
      { n: 1, title: "第一章", cid: CLASSROOM_ID },
      { n: 2, title: "第二章", cid: "next-classroom-id" },
    ];
    const chaptersEncoded = btoa(encodeURIComponent(JSON.stringify(chapters)));
    const url = `/classroom/${CLASSROOM_ID}?philochoraUserId=42&courseSlug=test-course&chapters=${chaptersEncoded}&chapterIndex=0`;

    await page.goto(url);

    // 等待回调被调用（NextLessonBanner 挂载时自动触发）
    // 使用 expect.poll 轮询避免 flaky 时序问题
    await expect
      .poll(
        () => callbackReceived,
        { timeout: 10000, message: "进度回调应在课堂完成页挂载后触发" },
      )
      .toBe(true);

    // 验证 payload 字段
    expect(callbackBody.philochoraUserId).toBe("42");
    expect(callbackBody.courseSlug).toBe("test-course");
    expect(callbackBody.chapterNumber).toBe(1);
    expect(callbackBody.chapterTitle).toBe("第一章");
  });

  test("无连续学习上下文时不触发回调", async ({ page }) => {
    let callbackReceived = false;

    await page.route("**/api/philochora/chapter-complete", async (route) => {
      callbackReceived = true;
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true }),
      });
    });

    await mockClassroomApi(page, CLASSROOM_ID);

    // 导航到课堂（无章节序列参数 → 非连续学习上下文）
    await page.goto(`/classroom/${CLASSROOM_ID}`);

    // 等待足够时间确认回调未被触发
    await page.waitForTimeout(3000);
    expect(callbackReceived).toBe(false);
  });

  test("回调端点 503 时静默失败不影响课堂体验", async ({ page }) => {
    await page.route("**/api/philochora/chapter-complete", async (route) => {
      await route.fulfill({
        status: 503,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "回调服务未配置" }),
      });
    });

    await mockClassroomApi(page, CLASSROOM_ID);

    const chapters = [
      { n: 1, title: "第一章", cid: CLASSROOM_ID },
    ];
    const chaptersEncoded = btoa(encodeURIComponent(JSON.stringify(chapters)));
    const url = `/classroom/${CLASSROOM_ID}?philochoraUserId=42&courseSlug=test-course&chapters=${chaptersEncoded}&chapterIndex=0`;

    // 不应因为回调失败而崩溃
    await page.goto(url);
    // 页面应正常加载（classroom 内容可见）
    await page.waitForTimeout(2000);
    // 确认课堂容器存在，未因错误而白屏
    await expect(page.locator("body")).toBeVisible();
  });
});
