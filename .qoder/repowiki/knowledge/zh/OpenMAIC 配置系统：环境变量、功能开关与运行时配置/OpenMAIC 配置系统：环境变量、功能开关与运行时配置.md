---
kind: configuration_system
name: OpenMAIC 配置系统：环境变量、功能开关与运行时配置
category: configuration_system
scope:
    - '**'
source_files:
    - lib/config/feature-flags.ts
    - lib/config/token-plan-presets.ts
    - lib/config/apply-token-plan.ts
    - lib/server/oauth-config.ts
    - lib/runtime/config.ts
    - next.config.ts
    - lib/fetch-base-path.ts
    - configs/font.ts
    - app/api/access-code/status/route.ts
    - app/api/access-code/verify/route.ts
    - app/api/health/route.ts
    - eval/orchestration/answering-runner.ts
---

## 配置系统与架构

OpenMAIC 采用**分层配置体系**，将配置分为三个层次：构建期环境变量（NEXT_PUBLIC_*）、服务端环境变量（process.env）和运行时配置（runtime config）。配置通过集中式模块统一管理（feature-flags、runtime config 等），避免散落的 process.env 直接调用；无独立配置文件（如 .env、config.yaml），全部以环境变量形式注入。

### 1. 功能开关（Feature Flags）

核心文件 `lib/config/feature-flags.ts` 提供统一的功能开关管理：
- **客户端可见开关**：使用 `NEXT_PUBLIC_` 前缀的环境变量，Next.js 在构建时内联到客户端代码
- **服务端专用开关**：不使用 `NEXT_PUBLIC_` 前缀，仅在服务器端生效
- **布尔值解析**：统一的 `readBoolean()` 函数处理 `'true'` 或 `'1'` 为启用，其他值视为禁用

主要开关包括：`isMaicEditorEnabled()`、`isPiChatEnabled()`、`resolveVocationalActive()`、`shouldShowVocationalTestUi()`、`isSettingsEnabled()`、`isVideoExportEnabled()`、`NEXT_PUBLIC_ENABLE_PPTX_IMPORT`。

### 2. Token Plan 配置系统

`lib/config/token-plan-presets.ts` 和 `apply-token-plan.ts` 实现了多模态 Token Plan 配置：
- **数据驱动设计**：通过声明式配置支持 LLM、图像、视频、TTS、Web Search 等多模态
- **一键应用**：单个 API Key 可同时配置多个服务提供者
- **内置预设**：MiniMax、火山方舟 Agent Plan 等预定义配置模板
- **可测试性**：通过注入的 actions 接口实现纯函数式的配置应用

### 3. OAuth 配置

`lib/server/oauth-config.ts` 提供 OIDC 发现机制：
- **自动发现**：优先从 `.well-known/openid-configuration` 端点获取配置
- **环境变量回退**：失败时使用 `OAUTH_ISSUER`、`OAUTH_CLIENT_ID`、`OAUTH_CLIENT_SECRET` 等环境变量
- **生产缓存**：配置结果在服务端缓存以减少请求

### 4. 运行时配置

`lib/runtime/config.ts` 提供单例模式的运行时配置：
- **一次性配置**：模块级初始化，防止运行时切换后端存储
- **延迟工厂**：支持 store 工厂函数懒加载
- **学习者标识**：可配置的 learner key 解析器
- **测试支持**：提供重置钩子用于测试环境清理

### 5. 部署与环境配置

- **basePath 支持**：`next.config.ts` 通过 `NEXT_PUBLIC_BASE_PATH` 支持子路径部署
- **fetch 拦截器**：`lib/fetch-base-path.ts` 自动为 `/api/` 请求添加 basePath 前缀
- **安全头配置**：动态设置 CSP、X-Frame-Options、HSTS 等安全响应头
- **独立部署**：支持 standalone 输出模式
- **服务端直读变量**：API Route 直接读取 `ACCESS_CODE`（访问码校验）、`TRUST_PROXY_HEADERS`（代理信任）、`NODE_ENV`、`npm_package_version`（版本回退 `'0.1.0'`）等

### 6. 评测脚本配置

`eval/` 目录下通过环境变量控制评测行为：`EVAL_SCENARIO`、`EVAL_AGENT_MODEL`、`EVAL_JUDGE_MODEL`、`EVAL_SAMPLES`、`EVAL_PASS_THRESHOLD`、`DEFAULT_MODEL` 等。

## 关键约定与规则

1. **环境变量命名规范**：客户端变量必须使用 `NEXT_PUBLIC_` 前缀，服务端变量不使用该前缀
2. **布尔值解析**：统一使用 `readBoolean()` 函数处理，只接受 `'true'` 或 `'1'`；直接读 `process.env` 的场景统一 `=== 'true'` 判断
3. **配置集中化**：所有配置访问都应通过对应的模块函数，禁止直接读取 `process.env`
4. **默认值策略**：所有配置都有合理的默认值，确保未配置时的降级行为
5. **测试友好**：配置模块提供重置函数和注入接口，便于单元测试
6. **安全性**：敏感配置（如 API Key）仅存在于服务端环境变量中，不应出现在代码中，通过部署平台注入
7. **文档化**：在 `.env.example` 中列出所有必需的环境变量及说明，便于团队协作

## 配置文件位置

- 功能开关：`lib/config/feature-flags.ts`
- Token Plan 预设：`lib/config/token-plan-presets.ts`、`lib/config/apply-token-plan.ts`
- OAuth 配置：`lib/server/oauth-config.ts`
- 运行时配置：`lib/runtime/config.ts`
- 部署配置：`next.config.ts`、`lib/fetch-base-path.ts`
- 字体配置：`configs/font.ts`
- 评测配置：`eval/orchestration/*`
