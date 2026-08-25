# ADR-0001: nginx 放行清单与应用 API 面视为同一契约

- **状态**：已采纳
- **日期**：2026-08-26
- **关联**：`CONTEXT.md`（API 面契约 / 响亮失败 / 穿透验证）

## 背景

生产环境（philochora.com/openmaic，托管部署）哲学课堂讨论环节恒报
「请选择一个模型」而无法进行讨论。审计结论：

1. 托管部署隐藏设置面板（`isSettingsEnabled()` 默认 OFF），客户端模型
   配置完全依赖 `GET /openmaic/api/server-providers` 自动下发。
2. VPS nginx（`/etc/nginx/sites-available/philochora.conf`）采用
   「黑名单 + 白名单 + 兜底 403」三层结构（侦查实锤，非纯白名单）：
   黑名单把 `server-providers` 与设置面板端点一并 403，白名单未收录
   该路径，请求落入兜底前即被黑名单拦截。
3. 客户端 `fetchServerProviders` 以 `if (!res.ok) return;` 静默吞掉失败，
   `modelId` 恒空，`startDiscussion` 前置校验失败。

故障暴露了两个结构性缺口：

- **配置漂移**：nginx 配置只存在于 VPS，仓库无事实源，"改一次丢一次"，
  新增 API 路由是否放行全凭记忆。
- **静默拦截**：边缘层 403 对客户端与运维均不可见，同类遗漏只能在
  生产以用户故障的形式暴露。

## 决策

1. `deploy/nginx/philochora.conf` 成为边缘配置的**唯一事实源**，经
   `scripts/deploy-nginx.sh` 部署（--dry-run 预览 diff；apply 自动备份 →
   `nginx -t` → reload → 穿透验证；失败自动回滚）。
2. **API 面契约**：`app/api/**` 的每个路由必须在契约文件中显式落位
   （白名单或显式黑名单）；落入兜底 403 视为违规。
   `scripts/check-api-surface.mjs` 在 pre-push 阻断（逃生口
   `SKIP_API_SURFACE_CHECK=1`）。
3. **部署门禁**：`scripts/deploy-health-check.mjs` 增加两项——
   `/api/health.llmConfigured === true`（服务端具备可用 LLM key+model）
   与 server-providers 穿透（必须到达应用层，非 nginx-403 页）。
4. **客户端响亮失败**：`fetchServerProviders` 失败时 `log.warn`（含状态码）
   并重试一次，最终失败置 `serverProvidersLoadFailed`；托管模式的模型
   校验失败文案改为可行动的「联系管理员」（三语）。
5. **保持拒绝**（托管安全意图）：`usage` / `provider/*` / `verify-*` /
   `comfyui-workflows` / `azure-voices` 为设置面板专属端点，托管模式下面板
   不可达，显式黑名单拒绝并向契约校验登记；`server-providers` 仅返回模型
   列表与配置存在性（无 key、无 baseUrl），放行不破坏安全意图。

## 侦查结论（白名单 vs 黑名单）

实配为三层混合：页面级黑名单（settings/config/admin 等）→ API 黑名单
（敏感端点 403）→ API 白名单（正则 `location ~*` 代理 3010）→
`/openmaic/` 兜底 403/404。原事故由 API 黑名单误伤（`server-providers`
在黑名单内），而非白名单遗漏——两类机制都做了针对性处理。

## 被否方案

- **仅最小放行**（只在黑名单删掉/白名单加一条 `server-providers`）：
  修好本次故障但不消灭故障类；下一个新路由仍可能静默落入兜底。否决。
- **仅加客户端日志**：运维可见性改善，但拦截本身仍在，用户侧功能持续
  损坏。否决。
- **全量放行 `/openmaic/api/`**：会把设置面板专属端点（含服务商配置面）
  暴露给托管模式的普通用户，违反托管安全意图。否决。

## 后果

- 新增/删除任何 `app/api/**` 路由时，必须同步更新契约文件，否则
  pre-push 阻断；边缘配置变更走 `deploy-nginx.sh`（备份、校验、回滚、
  穿透验证一条龙）。
- 观察项：`classroom/[id]/backfill-tts` 等管理端点依赖 `proxy.ts` 会话
  鉴权兜底（随 `classroom` 前缀放行）；若未来引入无鉴权的管理路由，
  契约校验只保证「显式落位」，不保证「落位正确」，评审时需人工把关。
