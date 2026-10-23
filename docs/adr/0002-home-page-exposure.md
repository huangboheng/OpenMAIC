# ADR-0002: 首页按部署环境开放

- **状态**：已采纳
- **日期**：2026-10-23
- **关联**：`proxy.ts`（SEC-02）、`app/page.tsx`、`app/layout.tsx`、`deploy/nginx/philochora.conf`、ADR-0001

## 背景

托管部署（philochora.com/openmaic）有意不提供 OpenMAIC 首页，唯一合法页面入口是课堂页 `/openmaic/classroom/{id}`。此前 `proxy.ts` 用一条无条件的页面白名单实现这件事：除课堂、API、静态资源外的页面一律 404。它同时挡住了本地开发，导致首页和生成流程无法在本地使用。

排查还发现两个事实：

1. **不能用 `NODE_ENV` 区分环境**。VPS 由 PM2 直接运行 `next dev -p 3010`（`ecosystem.dev.config.cjs`），`NODE_ENV=development`；本地和 VPS 的 `NEXT_PUBLIC_BASE_PATH` 又都是 `/openmaic`。
2. **proxy matcher 覆盖不到 basePath 根路径**。Next 16 会给 matcher 自动加 basePath 前缀（`get-page-static-info.js` 的 matcher 编译逻辑），原 matcher 编译为 `/openmaic/((?!...).*)`，精确的 `/openmaic` 不会进入 proxy。实测本地 `GET /openmaic` 返回 200，而 `/openmaic/generation-preview` 返回 404。生产目前只靠 nginx 的精确 404 兜底。

实现过程中还验证了一条**不可行路径**：把 `/` 改成服务端组件、在页面里 `notFound()`，并把客户端首页移到 `app/home-client.tsx`。这个结构会让本仓库的 Next 16.3.3 dev（Turbopack）在 `Compiling /` 处死锁；即使把页面简化成只返回 `<div>home-ok</div>` 仍然死锁，而原始客户端页面可以正常编译。因此最终保留客户端首页，把根路径门禁放回 proxy。

## 决策

1. 新增 **server-only** 开关 `OPENMAIC_HOME_ENABLED`，默认 OFF（只认 `true`/`1`，沿用 `lib/config/feature-flags.ts` 的 `readBoolean`）。
   - 本地 `.env.local`：`OPENMAIC_HOME_ENABLED=true`。
   - 托管 VPS：不配置（缺省 OFF）。nginx 继续对 `/openmaic`、`/openmaic/` 精确返回 404，对其它非白名单路径 403/404。
   - 自托管/Docker 需要首页时同样设为 true。
2. **proxy 根路径门禁**：`config.matcher` 增加 `'/'`。Next 会把 source `'/'` 编译成 `/openmaic`、`/openmaic/`、`/openmaic/index` 等根形式，补上原来的 matcher 漏洞。
   - 开关 OFF：根路径命中 `PAGE_ENTRY_PATTERN` 之外，proxy 直接返回 404（在鉴权和页面编译之前）。
   - 开关 ON：跳过页面白名单；根路径额外返回 `NextResponse.next()`，让本地直接渲染 UI 外壳，不触发 OAuth（根页面本身不含数据，API 仍然逐个鉴权）。其它页面（如 `/generation-preview`）仍走正常 OAuth。
3. **保留客户端首页**：`app/page.tsx` 继续是原来的 `'use client'` 首页，不做服务端包装、不移动文件。
4. **客户端出口**：根 layout 通过 `AppConfigProvider` 把 `homeEnabled` 布尔值下发。OFF 时课堂页的 logo / “返回首页”/课堂不存在 CTA 用 `window.location.assign('/')` 或普通锚点跳出 basePath，落到 Philochora 主站；ON 时仍用 Next router 回本地首页。
5. **两层防线**：应用层（proxy 根 matcher + 页面白名单）与边缘层（nginx）互相独立。任何一层漏掉，另一层仍能阻止托管环境渲染首页。

## 被否方案

- **按 `NODE_ENV` 判断**：VPS 跑 `next dev`，`NODE_ENV` 恒为 development，无法区分。
- **按 `NEXT_PUBLIC_BASE_PATH` 判断**：本地也配置 `/openmaic` 以复现托管拓扑。
- **服务端页面门禁 + 移动客户端首页**：本仓库 Next 16.3.3 dev/Turbopack 在 `/` 路由上死锁（见背景）；原客户端页面可正常编译。否决。
- **只靠 nginx**：单点防线；应用被直连或 nginx 配置漂移时首页会暴露。既有的“两层防线”约定不放弃。
- **用 `NEXT_PUBLIC_*` 做门禁**：会被编译进客户端 bundle，且违背仓库“server-only gate 不加 NEXT_PUBLIC_”的约定。

## 后果

- **matcher 里的 `'/'` 不能删**。没有它，basePath 根路径会绕过 proxy，托管环境只能靠 nginx；`tests/server/proxy-page-entry.test.ts` 锁住该声明。
- **根路径的本地 bypass 不能删**。开关 ON 时它让本地直接拿到 UI 外壳；删掉后根路径会进入 OAuth。托管模式下这段不可达（前面的门禁已 404）。
- **本地根路径仍不经过 proxy 鉴权**（现状）：未登录能看到首页 UI 壳，但 `/api/stages` 等返回 401，`/generation-preview` 与课堂页会走 OAuth。这是既有行为，本 ADR 不改变。
- **既有 e2e 首页 spec 仍红**：`e2e/fixtures/base.ts` 不注入 session cookie；根路径虽能渲染（200），但 API 会 401，子页会 307。这是既有测试缺口，不在本次范围。
- **托管出口假设主站根为 `/`**：`window.location.assign('/')` 在 `philochora.com/openmaic` 拓扑下正确；若未来换域名或挂载方式，需要改成显式主站 URL。
- 开关是 server-only，客户端只收到 `homeEnabled` 布尔值，不暴露 env；改动开关需要重启进程。
- **后续（2026-10-24）**：ADR-0003 新增 `OPENMAIC_AUTH_MODE=access-code`，本地模式放行访问码端点并让页面直出由 `AccessCodeGuard` 门禁；本 ADR 的根 matcher / 根 bypass 决策不变，托管默认 OAuth 行为不变。
