# ADR-0003: 本地独立运行的访问码鉴权模式

- **状态**：已采纳
- **日期**：2026-10-24
- **关联**：`proxy.ts`、`lib/config/auth-mode.ts`、`instrumentation.ts`、`components/access-code-guard.tsx`、ADR-0002、`docs/local-standalone.md`

## 背景

本分叉把 OpenMAIC 作为 Philochora 的子路径应用部署，`proxy.ts` 用 OAuth 会话（`openmaic_session`）或 Philochora 签发的无缝 cookie（`openmaic_access`）保护所有页面与 API。ADR-0002 只开放了本地根路径 `/` 的渲染，**没有恢复本地登录通道**：

- `/api/access-code/status` 与 `/api/access-code/verify` 自身也在 proxy 鉴权之后，未登录返回 401。`AccessCodeGuard` 解析不到 `enabled`，访问码弹窗永远不会出现；即使出现，verify 也会先被 401。
- 上游 OpenMAIC 的 `middleware.ts` 白名单放行 `/api/access-code/`，并让页面直出由前端弹窗门禁；本分叉在改 OAuth 时丢失了这两段。
- 本地 `.env.local` 的 `OAUTH_ISSUER` 曾指向 `http://localhost:3000`，但仓库没有 `/api/oauth/authorize` 路由，OAuth 无法在本地完成；`/generation-preview`、`/classroom/*` 未登录会 307 到不可用地址。

结果是本地进程能启动、首页能打开，但无法登录、无法生成。需要一条**不依赖 Philochora** 的本地独立运行路径，同时不改变托管部署的鉴权行为。

## 决策

1. **新增 server-only `OPENMAIC_AUTH_MODE`**，取值 `oauth`（默认）或 `access-code`。
   - 只有显式配置 `access-code` 且 `ACCESS_CODE` 非空时才进入本地模式；未知值或缺失访问码在启动时被 `validateAuthModeConfiguration()` 拒绝，不静默降级。
   - 不复用 `OPENMAIC_HOME_ENABLED`：首页可见性与鉴权方式是两个维度，显式模式也避免托管环境误开本地通道。
2. **proxy 分流**（仅 `access-code` 模式）：
   - `GET /api/access-code/status` 与 `POST /api/access-code/verify` 免鉴权，供弹窗自举；
   - 非 `/api/` 页面请求直接 `NextResponse.next()`，由根布局里的 `AccessCodeGuard` 渲染弹窗；
   - 其余 API 保持原有 401，直到浏览器持有用 `ACCESS_CODE` 签发的 `openmaic_access` cookie；
   - `oauth` 模式不进入上述分支，托管行为不变。
3. **启动校验**：`instrumentation.ts` 在 owner 校验前运行 `validateAuthModeConfiguration()`，配置错误以 `[boot]` 拒绝启动。
4. **本地 owner**：本地 `.env.local` 启用 `OWNER_SINGLE_USER=true`，所有本地访问共用 `local` 课程库。这样不依赖 proxy 预发 `anonymous_id`，避免首屏并发为同一浏览器创建多个 owner。
5. **托管不变**：托管不设置 `OPENMAIC_AUTH_MODE`，继续走 OAuth；nginx 白名单、API 面契约、根路径 404 规则均不改。

## 被否方案

- **复用 `OPENMAIC_HOME_ENABLED` 作为鉴权模式**：把“首页是否可见”和“用什么凭据登录”耦合；托管或自托管想调整其一都会意外改变另一项。
- **无条件恢复上游白名单**：托管环境也会暴露 `/api/access-code/verify`，多出一个可暴力尝试的入口。默认 `oauth` 且按模式放行更窄。
- **本地运行一个 Philochora OAuth IdP**：可行但重，且要求本地同时维护第二个服务；访问码已足够覆盖单人本地开发。
- **手工注入 `openmaic_session` cookie 作为正式方案**：只适合 e2e/调试，要求用户知道签名密钥，且绕过了用户可见的登录流程。
- **恢复 proxy 的 `anonymous_id` 预发**：能修多用户竞态，但会改动所有请求路径；本地单人场景用单用户 owner 更简单。

## 后果

- **访问码模式页面壳公开**：页面 HTML 可直接获取，但业务 API 仍要求签名 cookie；课堂 JSON 仍按不可猜 id 读取。该模式面向 localhost/私网，公网部署必须使用长随机 `ACCESS_CODE`，并建议放在反代后。
- **访问码端点的限流**：verify 路由自带 attempt limiter，但只有 `TRUST_PROXY_HEADERS=true` 时才按客户端 IP 生效；未设时不做共享限流，长访问码是主要防护。
- **单用户 owner**：所有能访问服务的人共用 `local` 库并拥有发布权限，访问码是唯一门禁。既有匿名 owner 的课程只有仍持有原 `anonymous_id` cookie 的浏览器可被 claim，其他浏览器的旧课程不会自动迁移。
- **193 个 legacy 课堂**：归属仍是 `system:legacy-classrooms`，可按 id/链接打开，但不进入 `local` 课程库；把它们迁入本地课程库是独立任务。
- **既有 e2e 缺口不变**：ADR-0002 记录的未登录 home/generation 用例仍不在本次范围；新增的 `e2e/tests/access-code-gate.spec.ts` 只覆盖访问码链路。
- **托管安全边界不变**：默认 `oauth` 时新分支不可达；nginx 仍对 `/openmaic` 精确 404、对非白名单页面 403/404；API 面契约不新增路由。
