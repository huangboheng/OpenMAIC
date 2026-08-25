# CONTEXT — OpenMAIC 领域术语表

> 本文件是项目的共享词汇表（Ubiquitous Language）。每个词条给出唯一
> 定义与代码锚点；_Avoid_ 列出历史误称，避免沟通歧义。
> 架构决策见 `docs/adr/`。

## 托管部署（Managed Deployment）

OpenMAIC 以子路径（`/openmaic`）嵌入宿主站点（Philochora）的部署形态：
设置面板被 `isSettingsEnabled()`（`NEXT_PUBLIC_SETTINGS_ENABLED`，默认
OFF）隐藏，用户无法自行填写任何 API key；全部模型/语音/图像能力由服务端
经 `GET /api/server-providers` 自动下发（见「server-configured provider」）。

_Avoid_：「无设置版」「锁死版」——准确说法是托管部署，设置能力被特性开关
关闭而非不存在。

## server-configured provider（服务端配置的服务商）

服务端（`.env` / YAML）持有 API key 的 LLM/图像/语音服务商。
`fetchServerProviders()` 将其合并进本地 settings store 并置
`isServerConfigured: true`；只暴露模型列表与「已配置」标志，**永不下发
key 与 baseUrl**（`lib/server/provider-config.ts: getServerProviders`）。

_Avoid_：「云端模型」「官方模型」——关键属性是 key 归属服务端，而非模型来源。

## API 面契约（API Surface Contract）

`app/api/**` 的每一个路由都必须在边缘配置
（`deploy/nginx/philochora.conf`）中显式落位：要么命中白名单
（`proxy_pass`），要么命中显式黑名单（`return 403`）。落入 `/openmaic/`
兜底 403 而未被显式声明的路由即契约违规。机器强制：
`scripts/check-api-surface.mjs`（pre-push）+
`scripts/deploy-health-check.mjs`（部署门禁）。决策见 ADR-0001。

_Avoid_：「nginx 白名单」单独出现时易与页面级屏蔽规则混淆——
契约同时包含白名单、显式黑名单与兜底三层，统称 API 面。

## 响亮失败（Loud Failure）

运行时故障必须产生可观测信号（日志 + 用户可见反馈 + 部署门禁），禁止
静默降级。对照案例：`fetchServerProviders` 曾以 `if (!res.ok) return;`
静默吞掉 403，导致托管模式课堂讨论恒报「请选择一个模型」且长期无人察觉；
修复后失败会 `log.warn`、重试一次、置 `serverProvidersLoadFailed` 标志，
托管模式弹出可行动的「联系管理员」提示（ADR-0001）。

_Avoid_：「优雅降级」用于描述此类故障——对依赖外部配置的链路，
无声降级 = 无声故障。

## 配置未送达（Config Not Delivered）

用户视角的「没配模型」在托管部署下的真实含义：模型配置存在且正确，
但下发链路（边缘路由 → `/api/server-providers` → 客户端合并）中某环
失败，配置从未到达客户端。诊断入口：`curl /openmaic/api/server-providers`
期望 401/200（到达应用层）；若为带 `<center>nginx</center>` 的 403 页，
则是边缘拦截。

_Avoid_：「没配模型」「模型配置缺失」——在托管部署中用户端根本没有
配置入口，这类表述会把排障引向不存在的用户配置。

## 穿透验证（Edge Penetration Check）

部署后对公网端点的直接探测，用于区分「边缘层拦截」（nginx 默认 403
HTML 页）与「应用层响应」（401/200 JSON）。判定基准：响应体是否为
nginx 默认页，而非单纯看状态码。实现见 `scripts/deploy-nginx.sh`
与 `scripts/deploy-health-check.mjs` 第 4 项。
