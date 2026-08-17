---
name: xhs-publish
description: 通过 browser-use MCP 自动化操作小红书创作服务平台（creator.xiaohongshu.com），完成从内容准备到图文/长文笔记发布的完整工作流。覆盖标题/正文/图片/话题标签/可见性设置/发布前确认/发布后验证。
triggers:
  - "发布小红书"
  - "小红书笔记"
  - "小红书长文"
  - "自动发布笔记"
  - "xhs publish"
  - "philochora 推广"
version: 1.0
tested_at: 2026-08-18
tested_chromeless: browser-use MCP (Qoder 内置浏览器)
---

# 小红书自动发布笔记 Skill

## 何时使用

- 自动化发布小红书**图文笔记**或**长文笔记**
- 批量发布已写好的内容（同一账号多篇、或多账号）
- 品牌持续运营：定时/多次发布同一品牌（如 Philochora）的笔记
- 复现实操过的小红书发布流程，避免每次重新探索

> ⚠️ 不适用场景：登录前请用户手工扫码/短信验证（这是非自动化步骤）；需要复杂人工审核（如原创声明认定）的场景。

---

## 前置条件（执行前必须确认）

| 条件 | 检查方式 |
|------|---------|
| Qoder 内置浏览器已登录目标小红书账号 | `browser-use: navigate_page("https://creator.xiaohongshu.com/new/home")` 后查看是否含账号信息（Bosun/头像），无则看到登录页 |
| 准备好发布素材（标题、正文、图片路径） | 用户提供，或从项目文件读取 |
| 图片格式合规 | png/jpg/jpeg/webp；≤32MB；推荐 3:4 比例 |

如果浏览器**未登录**：停止任务，告知用户到 Qoder 内置浏览器手动登录（短信验证码），完成后再触发 skill。

---

## 通道选型（重要）

| 通道 | 适用情况 | 限制 |
|------|---------|------|
| **browser-use MCP（首选）** | Qoder 内置浏览器，登录后**无沙箱限制**，所有工具直接可用 | 需要在 Qoder 内置浏览器登录 |
| bsk/browser-skill | 用户日常 Chrome（带真实登录态） | `click`/`fill`/`evaluate` 受 Agent Window 沙箱限制——需先 `tab borrow <user-tab-id>`（需用户在浏览器中确认 overlay），否则报错 "operation denied by the Agent Window sandbox" |
| Playwright + CDP | 自管 Chrome 远程调试 | 需 Chrome 以 `--remote-debugging-port` 启动 |

**默认走 browser-use MCP**。若用户坚持用日常 Chrome，先 `bsk tab borrow`，失败则切换 browser-use。

---

## 关键限制（硬规则）

发布前**必须**心中有数，违反会被截断或拒绝：

| 字段 | 图文笔记 | 长文（写长文） |
|------|---------|---------------|
| 标题 | **≤20 字** | 编辑器 ≤64 字，但**发布页截断为 20 字**（必须重新填） |
| 正文 | **≤1000 字** | 编辑器 ≤6000 字；**发布页简介 ≤1000 字**（核心摘要） |
| 图片 | 最多 18 张；png/jpg/jpeg/webp；≤32MB | 一键排版自动分图（无需上传图片） |
| 话题 | 通过 `#` + 关键词搜索 → 点选；选后形成 `#话题[话题]#` 文本 | 同左 |
| 可见性 | 公开 / 仅自己 / 仅互关 / 只给谁看 / 不给谁看 | 同左 |

**其它陷阱**：
- 长文编辑器与发布页标题**不同步**（编辑器 64 字内，发布页重新限制 20 字）——自动化需在发布页**重填** ≤20 字标题
- 标题超限 UI 会标红但**不拦截输入**，发布时才可能失败
- 草稿**存于浏览器本地**（localStorage/IndexedDB），清除浏览器数据会丢失
- 长文草稿上限 100 篇，超出自动删除最后一篇
- 富文本编辑器 `[contenteditable=true]` 用 `fill` 直接覆盖；追加文本用 `evaluate_script` + `document.execCommand('insertText')`

---

## 工具与定位

工具来自 browser-use MCP：
- `navigate_page(url)`、`take_snapshot()`、`click(uid)`、`fill(uid, value)`、`upload_file(uid, filePath)`、`evaluate_script(function)`、`wait_for(text, timeout)`、`press_key(key)`

定位策略：
- 文本/按钮 → `take_snapshot()` 拿 uid（`uid=NN_M` 格式），直接 `click(uid)`
- 无文本图标 → `evaluate_script` 枚举 `button.menu-item` 的 SVG 或 DOM
- 图片按钮 → 找 `[class*="upload"]` 或 `选择文件`
- 富文本 → `fill` 整段覆盖；追加用 `execCommand('insertText')`

---

## 工作流（图文笔记 · target=image）

```
1. 验证登录（navigate /new/home → 确认无登录页）
2. navigate /publish/publish?from=menu&target=image
3. upload_file(图文选择文件按钮, 本地路径) → click 上传图片
4. fill 标题文本框 (placeholder="填写标题会有更多赞哦")（≤20 字）
5. fill 正文文本框（≤1000 字；如含话题，用话题按钮流）
6. 添加话题：click 话题按钮 → 输入关键词 → click 搜索结果首位
7. 设置可见性：click "公开可见" → 选一项（公开/仅自己/仅互关/只给谁看/不给谁看）
8. [可选] 原创声明、地点、定时发布、合拍/复制
9. ⚠️ 发布前向用户确认（小红书发布公开操作、不可撤回）
10. click 发布 → 等 URL 变为 ?published=true
11. navigate /new/note-manager → 提取 noteId（data-impression）→ 拼接文章 URL
```

---

## 工作流（长文笔记 · target=article）★ 长文章主路径

长文发布是**两段式**：编辑器 → 一键排版 → 发布设置页 → 发布

```
1. 验证登录
2. navigate /publish/publish?from=menu&target=article
3. click 新的创作 → 进入编辑器
4. fill 标题（≤64 字）→ fill 正文（≤6000 字；支持 Markdown、emoji）
   注：编辑器自动保存到草稿（"自动保存于 HH:MM"）
5. click 一键排版 → 等待按钮从"排版中"恢复（约 10s）
   → 自动分图为 N 张滑动图片（实测 637 字 → 4 张）
   → 出现 20 种模板选择（简约基础/优雅几何/杂志先锋等）
6. click 下一步 → 进入发布设置页
7. ⚠️ 重填标题：发布页限制 ≤20 字（编辑器标题会显示但**仍需填新标题**）
8. fill 正文（≤1000 字，核心摘要）→ 添加话题 → 设置可见性/原创/定时等
9. ⚠️ 发布前向用户确认
10. click 发布 → published=true
11. 笔记管理提取 noteId → 拼接文章 URL
```

---

## 完整复用代码骨架

伪代码（可在 agent 中直接拼装为工具调用序列）：

```typescript
async function publishXhsArticle(opts: {
  type: 'image' | 'article';
  title: string;           // ≤20 字
  articleTitle?: string;   // 长文编辑器标题（≤64 字）
  body: string;            // 图文 ≤1000 字 / 长文简介 ≤1000 字
  articleBody?: string;    // 长文编辑器正文（≤6000 字）
  imagePath?: string;      // 图文必填
  topics: string[];        // 3~5 个话题名
  visibility: 'public' | 'private' | 'friends' | 'whitelist' | 'blacklist';
}) {
  // 1. 登录检查
  await mcp('navigate_page', { url: 'https://creator.xiaohongshu.com/new/home' });
  const snap = await mcp('take_snapshot', {});
  if (snap.includes('登录') && snap.includes('短信')) throw new Error('未登录');

  if (opts.type === 'image') {
    // 图文流程
    await mcp('navigate_page', { url: 'https://creator.xiaohongshu.com/publish/publish?from=menu&target=image' });
    // 上传图片
    const fileBtn = await findUidByText('选择文件', snap);
    await mcp('upload_file', { uid: fileBtn, filePath: opts.imagePath });
    const uploadBtn = await findUidByText('上传图片');
    await mcp('click', { uid: uploadBtn });
    // 标题/正文
    await mcp('fill', { uid: await findUidByPlaceholder('填写标题会有更多赞哦'), value: opts.title });
    await mcp('fill', { uid: await findUidByText('输入文字'), value: opts.body });
    // 话题
    for (const t of opts.topics) {
      await mcp('click', { uid: await findUidByText('话题') });
      await mcp('evaluate_script', { function: `() => insertText('${t}')` });
      await mcp('click', { uid: await findUidByText('#' + t) });
    }
    // 可见性
    await mcp('click', { uid: await findUidByText(opts.visibility === 'private' ? '仅自己可见' : '公开可见') });
    if (opts.visibility === 'private') await mcp('click', { uid: await findUidByText('仅自己可见') });
    // ⚠️ 人工确认后发布
    await mcp('click', { uid: await findUidByText('发布') });
  } else {
    // 长文流程
    await mcp('navigate_page', { url: 'https://creator.xiaohongshu.com/publish/publish?from=menu&target=article' });
    await mcp('click', { uid: await findUidByText('新的创作') });
    await mcp('fill', { uid: await findUidByPlaceholder('输入标题'), value: opts.articleTitle });
    await mcp('fill', { uid: await findUidByClass('contenteditable=true'), value: opts.articleBody });
    await mcp('click', { uid: await findUidByText('一键排版') });
    await mcp('wait_for', { text: '下一步', timeout: 30000 });
    await mcp('click', { uid: await findUidByText('下一步') });
    // 发布设置页（标题/正文/话题/可见性）
    await mcp('fill', { uid: await findUidByPlaceholder('填写标题会有更多赞哦'), value: opts.title });
    await mcp('fill', { uid: await findUidByClass('contenteditable=true'), value: opts.body });
    // ... 同图文的 话题/可见性 流程
    await mcp('click', { uid: await findUidByText('发布') });
  }

  // 验证
  await mcp('navigate_page', { url: 'https://creator.xiaohongshu.com/new/note-manager' });
  const noteId = await mcp('evaluate_script', {
    function: `() => {
      const c = [...document.querySelectorAll('.note-card')].find(e => e.innerText.includes('${opts.title}'));
      return c ? JSON.parse(c.getAttribute('data-impression')).noteTarget.value.noteId : null;
    }`
  });
  return `https://www.xiaohongshu.com/explore/${noteId}`;
}
```

> ⚠️ 实际执行需根据快照动态解析 uid，参考 xhs-creator-analysis.md §8 的定位方法。

---

## 错误处理

| 错误 | 原因 | 处理 |
|------|------|------|
| `operation denied by the Agent Window sandbox` | bsk 用了用户 tab，未 borrow | 切到 browser-use MCP，或重新 borrow |
| `redirectReason=401` | browser-use 实例未登录 | 告知用户到 Qoder 内置浏览器手动登录 |
| `Insufficient Credits` | ImageGen 额度不足 | 跳过 AI 配图，用平台一键排版替代 |
| 发布按钮一直 disabled | 标题超 20 字/正文超 1000 字/有必填项未填 | 检查表单字段提示 |
| `选择文件` 按钮变化 | 部分浏览器需 `evaluate_script` 找 input[type=file] | 改用 evaluate 直接设置或重试 |

---

## 实测案例（参考）

- **测试文章**：《哲学之境：AI 陪你读懂哲学》（722 字正文 + 5 标签） → 发布为长文
- **关键数据**：标题 20/20、正文 287/1000、话题 #哲学(16.9亿浏览) #AI学习(1.6亿) #智能学习(391.3万)
- **发布结果**：成功，noteId=`6a833ab7000000002402d772`，URL `https://www.xiaohongshu.com/explore/6a833ab7000000002402d772`，可见性"仅自己可见"，状态"审核中"

---

## 相关资产

- `e:\hermes\workspace\openmaic\.qoder\xhs-creator-analysis.md`：完整页面功能清单与按钮定位参考
- `e:\hermes\workspace\openmaic\.qoder\xhs-test-article.md`：测试文章样本
- `e:\hermes\workspace\openmaic\.qoder\xhs-cards\philochora-intro\`：可选的 AI 配图方案（ImageGen 额度恢复后可生成）

## 扩展建议

- 批量发布：循环调用工作流，每个账号/文章用独立 session
- 定时发布：发布前勾选"定时发布" + 设置时间
- 内容素材库：维护 `articles/<brand>/` 目录，每个文章一个文件夹（含 title.md、body.md、cover.png、topics.json）