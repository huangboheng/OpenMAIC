---
kind: error_handling
name: 错误处理体系：统一 API 错误码、LLM 错误映射与重试机制
category: error_handling
scope:
    - '**'
source_files:
    - lib/server/api-response.ts
    - lib/server/llm-error-response.ts
    - lib/generation/generation-retry.ts
    - lib/audio/tts-providers.ts
    - lib/server/model-fetch.ts
    - lib/pbl/v2/agents/planner.ts
    - lib/logger.ts
---

## 1. 使用的系统与模式

该仓库采用分层错误处理架构，核心由三部分组成：
- **统一的 API 响应格式**：通过 `lib/server/api-response.ts` 定义 `ApiErrorCode` 枚举和 `apiError()`/`apiSuccess()` 辅助函数，所有 API Route 返回标准化的 `{ success, errorCode, error, details? }` 结构。
- **LLM 上游错误映射**：`lib/server/llm-error-response.ts` 将 `ai` 库的 `APICallError`/`RetryError` 以及任意带 `statusCode/status/status_code` 字段的错误对象解析为 HTTP 状态码，并映射到 `RATE_LIMITED` 或 `UPSTREAM_ERROR` 错误码，屏蔽上游细节。
- **可重试生成器**：`lib/generation/generation-retry.ts` 提供 `withGenerationRetry()` 和 `isRetryableGenerationError()`，基于 HTTP 状态码（408/409/425/429/5xx）、消息正则匹配（rate limit、timeout、network 等）和 `AbortError` 检测实现指数退避 + jitter 重试。

此外，各业务域定义了领域特定的 Error 子类（如 `TTSRateLimitError`、`ModelFetchError`、`PlannerV2Error`、`ChatStorageLockUnavailableError` 等），用于在调用栈中传递结构化错误信息。日志通过 `lib/logger.ts` 的 `createLogger(tag)` 输出，支持 `LOG_LEVEL` 和 `LOG_FORMAT=json` 环境变量控制。

## 2. 关键文件与包
- `lib/server/api-response.ts` — 统一 API 错误码常量、`ApiErrorBody` 类型、`apiError()`/`apiSuccess()` 工厂
- `lib/server/llm-error-response.ts` — LLM 上游错误 → HTTP 状态码 → 标准错误体映射
- `lib/generation/generation-retry.ts` — 重试策略、可重试错误判定、`withGenerationRetry` 包装器
- `lib/audio/tts-providers.ts` — TTS 领域错误类 `TTSRateLimitError` 及 `throwIfTtsRateLimited()` 工具
- `lib/server/model-fetch.ts` — `ModelFetchError` 携带上游 HTTP 状态供路由层区分 401 vs 404
- `lib/pbl/v2/agents/planner.ts` — `PlannerV2Error` 携带 partial 结果供上层回退
- `lib/utils/chat-storage.ts` / `lib/utils/chat-storage-lock.ts` — 存储锁相关领域错误
- `lib/logger.ts` — 结构化日志（支持 JSON 格式）

## 3. 架构与约定
- **API 层**：所有 `app/api/**/*.ts` 路由应使用 `apiError(code, status, message, details?)` 返回错误，禁止直接 `throw new Error`；成功路径用 `apiSuccess(data)`。
- **上游错误透明化**：LLM/HTTP 调用失败时，先尝试提取 `statusCode`/`status`/`status_code`，再由 `llmApiError()` 转换为标准错误体，不泄露上游 URL、凭据或原始响应体。
- **重试边界**：仅对“可重试”错误（网络超时、429、5xx、message 匹配 rate limit/timeout/fetch failed 等）应用 `withGenerationRetry()`；400/401/403/404/422 等客户端错误直接抛出。
- **取消语义**：`isAbortError()` 兼容浏览器 `DOMException('AbortError')`、Node `Error.name === 'AbortError'` 以及普通 `{ name: 'AbortError' }` 对象，确保跨运行时取消传播。
- **领域错误类**：每个子系统（TTS、PBL Planner、模型探测、存储锁等）定义自己的 `extends Error` 子类，携带额外字段（如 `provider`、`partial`、`status`），便于上层精准捕获与降级。

## 4. 开发者应遵循的规则
1. **API 路由**：始终通过 `apiError()` 返回错误，使用 `API_ERROR_CODES` 中的预定义码；新增错误需先在常量中声明。
2. **上游调用**：对第三方 API 的错误，优先检查 `response.ok`，非 2xx 时读取 body 并抛出自描述 `Error`；若需要区分 429，使用对应领域的 `throwIfXxxRateLimited()` 或直接抛领域错误类。
3. **重试逻辑**：仅在明确可重试的场景使用 `withGenerationRetry()`，并在 `onRetry` 回调中记录重试原因；传入 `AbortSignal` 以支持用户取消。
4. **错误分类**：使用 `isRetryableGenerationError()` 判断是否重试；不要自行硬编码重试条件，复用已有规则集。
5. **日志**：使用 `createLogger('tag')` 输出结构化日志，生产环境建议设置 `LOG_LEVEL=info`，调试时可设为 `debug`；JSON 格式通过 `LOG_FORMAT=json` 启用。
6. **前端错误展示**：客户端根据 `errorCode` 显示用户友好提示，避免直接暴露 `error.message` 或堆栈。
7. **新增领域错误**：如需新的错误类型，定义 `class XxxError extends Error` 并添加必要字段，在调用点抛出，在上层按类型捕获而非字符串匹配。