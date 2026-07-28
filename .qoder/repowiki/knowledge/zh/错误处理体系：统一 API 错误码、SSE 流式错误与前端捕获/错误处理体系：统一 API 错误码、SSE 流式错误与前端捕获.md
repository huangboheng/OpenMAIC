---
kind: error_handling
name: 错误处理体系：统一 API 错误码、SSE 流式错误与前端捕获
category: error_handling
scope:
    - '**'
source_files:
    - lib/server/api-response.ts
    - lib/logger.ts
    - lib/server/ssrf-guard.ts
    - app/api/chat/pi/route.ts
    - app/api/agent/edit/route.ts
    - app/api/azure-voices/route.ts
    - lib/utils/iframe.ts
---

## 1. 使用的系统/模式
- **服务端**：基于 Next.js App Router 的 API 路由，通过统一的 `apiError` / `apiSuccess` 返回结构化 JSON 响应。
- **错误码集中管理**：`API_ERROR_CODES` 常量定义所有业务错误码（如 `MISSING_REQUIRED_FIELD`、`INVALID_REQUEST`、`UPSTREAM_ERROR`、`INTERNAL_ERROR` 等），配合 TypeScript 类型 `ApiErrorCode` 保证强类型。`ApiErrorBody` 接口规范了 `{ success: false, errorCode, error, details? }` 的统一结构。
- **SSE 流式错误**：对于长连接（SSE）场景，错误通过事件消息 `{ type: 'error', data: { message } }` 推送给客户端，并在 finally 中确保 writer 关闭。
- **日志记录**：使用 `lib/logger.ts` 提供的 `createLogger(tag)` 生成带时间戳、级别和 tag 的结构化日志，支持 `LOG_LEVEL` 和 `LOG_FORMAT=json` 环境变量控制输出格式。
- **前端错误捕获**：在 iframe 环境中通过 `unhandledrejection` 监听并上报未处理的 Promise 拒绝。

## 2. 关键文件与包
- `lib/server/api-response.ts` — 统一 API 错误码、错误体类型、`apiError`/`apiSuccess` 工厂函数。
- `lib/logger.ts` — 轻量结构化日志器，支持 debug/info/warn/error 四级。
- `lib/server/ssrf-guard.ts` — SSRF 防护工具，对外部 URL 进行安全校验，失败时返回错误信息字符串供 `apiError` 包装。
- `app/api/chat/pi/route.ts` — SSE 流式 API 的错误处理示例：try/catch 包裹主逻辑，异常时发送 `type: 'error'` 事件并关闭 writer。
- `app/api/agent/edit/route.ts` — SSE Agent 编辑端点：在 `ReadableStream` 的 start/cancel 中处理中断和异常，finally 中发送 `event: close`。
- `app/api/azure-voices/route.ts` — 典型 REST 错误处理：参数校验 → `apiError`；SSRF 校验失败 → `INVALID_URL`；上游 fetch 失败 → `UPSTREAM_ERROR`；未知异常 → `INTERNAL_ERROR`。
- `lib/utils/iframe.ts` — 前端 iframe 内 `unhandledrejection` 监听，将错误通过 postMessage 上报。

## 3. 架构与约定
- **分层职责清晰**：
  - API 路由层负责参数校验、业务异常分类，统一调用 `apiError(code, status, message, details?)` 返回。
  - 工具层（如 `ssrf-guard`）返回纯字符串错误信息，由调用方决定 HTTP 状态码和错误码。
  - 日志层独立于错误处理，仅用于记录上下文，不改变控制流。
- **错误码枚举化**：所有错误码集中在 `API_ERROR_CODES` 中，新增错误需在此扩展，避免硬编码字符串散落各处。
- **SSE 错误语义化**：流式接口不使用 HTTP 状态码表达业务错误，而是通过事件消息传递，保持连接稳定，便于客户端增量处理。
- **前端兜底**：iframe 内全局捕获 `unhandledrejection`，防止子应用崩溃导致父应用无感知。

## 4. 开发者应遵循的规则
1. **所有 API 路由必须使用 `apiError`/`apiSuccess`**，禁止直接 `new Response(JSON.stringify(...))` 返回错误。
2. **错误码必须来自 `API_ERROR_CODES`**，不得自行拼写字符串；新增错误码需在常量中声明并补充文档说明。
3. **参数校验失败优先返回 4xx**（如 `MISSING_REQUIRED_FIELD`、`INVALID_REQUEST`），业务逻辑异常返回对应业务码（如 `GENERATION_FAILED`），仅真正不可恢复的内部错误才用 `INTERNAL_ERROR` 500。
4. **SSE 接口必须在 try/catch 中捕获异常**，并通过 `send({ type: 'error', data })` 推送错误事件，同时在 finally 中确保 writer/stream 正确关闭。
5. **外部 URL 访问前必须调用 `validateUrlForSSRF`**，若返回非 null 则立即 `apiError('INVALID_URL', 403, message)`。
6. **所有可能抛出的异常路径都要 log.error**，包含足够的上下文（如 model、userId、requestId 等），但不得泄露敏感信息。
7. **前端组件中的 try/catch 应向上抛出或转换为 UI 友好的提示**，避免静默失败；在 iframe 场景中依赖 `unhandledrejection` 作为兜底上报。
8. **不要在业务代码中使用 `throw new Error('...')` 作为正常流程控制**，错误对象仅用于异常分支，且 message 应保持简洁可读。