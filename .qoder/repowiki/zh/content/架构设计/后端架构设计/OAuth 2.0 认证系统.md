# OAuth 2.0 认证系统

<cite>
**本文引用的文件**   
- [app/api/auth/callback/route.ts](file://app/api/auth/callback/route.ts)
- [lib/server/oauth-client.ts](file://lib/server/oauth-client.ts)
- [lib/server/oauth-config.ts](file://lib/server/oauth-config.ts)
- [lib/server/session-cookie.ts](file://lib/server/session-cookie.ts)
- [app/api/access-code/status/route.ts](file://app/api/access-code/status/route.ts)
- [app/api/access-code/verify/route.ts](file://app/api/access-code/verify/route.ts)
- [lib/server/access-token.ts](file://lib/server/access-token.ts)
- [components/access-code-guard.tsx](file://components/access-code-guard.tsx)
- [components/access-code-modal.tsx](file://components/access-code-modal.tsx)
- [proxy.ts](file://proxy.ts)
- [app/api/classroom/route.ts](file://app/api/classroom/route.ts)
- [app/api/classroom-media/[classroomId]/[...path]/route.ts](file://app/api/classroom-media/[classroomId]/[...path]/route.ts)
- [lib/server/classroom-storage.ts](file://lib/server/classroom-storage.ts)
- [lib/classroom/load-classroom.ts](file://lib/classroom/load-classroom.ts)
- [app/api/persistence/[...path]/route.ts](file://app/api/persistence/[...path]/route.ts)
- [lib/persistence/server-auth.ts](file://lib/persistence/server-auth.ts)
- [app/api/public/[...path]/route.ts](file://app/api/public/[...path]/route.ts)
</cite>

## 更新摘要
**变更内容**   
- **新增** `/api/public` 端点添加到认证白名单，支持公共资源静态文件访问
- **增强** 代理中间件支持公共资源路由，绕过 OAuth 认证流程
- **引入** 应用层 public/ 目录代理服务，解决 Next.js 16 + Turbopack 部署问题
- **改进** 认证白名单架构，新增公共资源访问类型
- **优化** 静态资源安全访问，包含路径白名单和目录遍历防护

## 产品概述
本系统为 OpenMAIC 的 OAuth 2.0 认证子系统，基于 Authorization Code + PKCE 流程与 OIDC Discovery，完成用户登录、会话建立与访问控制。核心能力包括：
- 通过 Philochora OIDC 服务进行授权码交换，获取 access_token、id_token、refresh_token
- 使用 HMAC-SHA256 签名会话 Cookie，在 Edge/Node 双环境兼容验证
- 提供"访问码"模式作为轻量级鉴权补充（适用于无 OIDC 或快速部署场景）
- **新增**无缝认证集成，支持 Philochora SSO 与 OpenMAIC 教室的直接认证
- **新增**GET-only 认证白名单，允许安全的只读数据访问而无需完整认证流程
- **新增**服务器到服务器认证支持，通过 Bearer Token 实现内部 API 通信
- **新增**公共资源静态文件访问，支持 basePath 部署模式下的静态资源服务
- **新增**增强的错误处理机制，通过 ClassroomAuthError 精确区分认证失败与其他错误
- 前端根据后端状态动态展示访问码弹窗并维持登录态

适用场景：
- 面向教师/讲师的课件生成与课堂互动平台
- 需要统一身份认证与跨端会话保持的 Web 应用
- 需要快速部署且可配置外部 OIDC 提供商的系统
- **新增**需要无缝单点登录体验的教育平台集成
- **新增**需要公开只读教室数据访问的教育资源共享场景
- **新增**需要服务器到服务器认证的微服务架构
- **新增**需要静态资源服务的多语言部署场景

## 核心业务流程
本节描述五种主要认证路径：OAuth 2.0 授权码流程、访问码流程、无缝认证流程、GET-only 白名单访问流程和公共资源访问流程。

```mermaid
sequenceDiagram
participant U as "用户浏览器"
participant APP as "OpenMAIC Next.js"
participant OIDC as "Philochora OIDC"
participant Proxy as "代理中间件"
Note over U,Proxy : 传统认证流程
U->>APP : 发起登录携带 state/code_verifier
APP-->>U : 重定向到 OIDC 授权页含 code_challenge
U->>OIDC : 用户输入凭据并授权
OIDC-->>APP : 回调 /api/auth/callback?code&state
APP->>OIDC : 用 code+code_verifier 交换 tokens
OIDC-->>APP : 返回 access_token/id_token/refresh_token
APP->>APP : 解码 id_token，构建 SessionData
APP->>APP : 生成 HMAC 签名的 session cookie
APP-->>U : 设置 httpOnly cookie 并重定向回原页面
Note over U,Proxy : GET-only 白名单访问流程
U->>Proxy : GET /api/classroom?id=xxx (无认证)
Proxy->>Proxy : 检查 GET_AUTH_WHITELIST
Proxy->>Proxy : 应用速率限制
Proxy-->>U : 直接返回教室数据 (无需认证)
Note over Proxy,APP : 公共资源访问流程
U->>Proxy : GET /api/public/logos/logo.png
Proxy->>Proxy : 检查 AUTH_WHITELIST (/api/public)
Proxy-->>U : 直接转发请求 (跳过 OAuth)
U->>APP : /api/public/logos/logo.png
APP->>APP : 验证路径安全性
APP-->>U : 返回静态文件
Note over Proxy,APP : 服务器到服务器认证流程
SVC->>Proxy : POST /api/persistence (Bearer Token)
Proxy->>Proxy : 检查 AUTH_WHITELIST (/api/persistence)
Proxy-->>SVC : 直接转发请求 (跳过 OAuth)
SVC->>SVC : authenticatePersistenceRequest()
SVC-->>SVC : 验证 PERSISTENCE_DEV_TOKEN
SVC-->>SVC : 返回持久化数据
```

**图表来源** 
- [app/api/auth/callback/route.ts:73-116](file://app/api/auth/callback/route.ts#L73-L116)
- [lib/server/oauth-client.ts:1-130](file://lib/server/oauth-client.ts#L-L130)
- [lib/server/oauth-config.ts:1-81](file://lib/server/oauth-config.ts#L1-L81)
- [lib/server/session-cookie.ts:24-32](file://lib/server/session-cookie.ts#L24-L32)
- [proxy.ts:92-116](file://proxy.ts#L92-L116)
- [app/api/public/[...path]/route.ts:52-97](file://app/api/public/[...path]/route.ts#L52-L97)
- [app/api/persistence/[...path]/route.ts:173-199](file://app/api/persistence/[...path]/route.ts#L173-L199)
- [lib/persistence/server-auth.ts:29-38](file://lib/persistence/server-auth.ts#L29-L38)

```mermaid
flowchart TD
Start(["进入应用"]) --> CheckStatus["调用 /api/access-code/status"]
CheckStatus --> Enabled{"是否启用访问码?"}
Enabled -- 否 --> Allow["直接放行"]
Enabled -- 是 --> CheckAuth{"检查认证状态"}
CheckAuth --> SeamlessToken{"是否存在有效的 openmaic_access token?"}
SeamlessToken -- 是 --> Allow
SeamlessToken -- 否 --> OAuthSession{"是否存在有效的 OAuth session?"}
OAuthSession -- 是 --> Allow
OAuthSession -- 否 --> ShowModal["显示 AccessCodeModal"]
ShowModal --> Submit["POST /api/access-code/verify"]
Submit --> Verify{"校验成功?"}
Verify -- 否 --> Error["提示错误并重试"]
Verify -- 是 --> SetCookie["设置 openmaic_access 会话 Cookie"]
SetCookie --> Allow
```

**图表来源** 
- [components/access-code-guard.tsx:16-38](file://components/access-code-guard.tsx#L16-L38)
- [components/access-code-modal.tsx:27-53](file://components/access-code-modal.tsx#L27-L53)
- [app/api/access-code/status/route.ts:6-31](file://app/api/access-code/status/route.ts#L6-L31)
- [app/api/access-code/verify/route.ts:6-41](file://app/api/access-code/verify/route.ts#L6-L41)
- [lib/server/access-token.ts:3-25](file://lib/server/access-token.ts#L3-L25)

**章节来源**
- [app/api/auth/callback/route.ts:73-116](file://app/api/auth/callback/route.ts#L73-L116)
- [lib/server/oauth-client.ts:1-130](file://lib/server/oauth-client.ts#L1-L130)
- [lib/server/oauth-config.ts:1-81](file://lib/server/oauth-config.ts#L1-L81)
- [lib/server/session-cookie.ts:24-99](file://lib/server/session-cookie.ts#L24-L99)
- [components/access-code-guard.tsx:16-38](file://components/access-code-guard.tsx#L16-L38)
- [components/access-code-modal.tsx:27-53](file://components/access-code-modal.tsx#L27-L53)
- [app/api/access-code/status/route.ts:6-31](file://app/api/access-code/status/route.ts#L6-L31)
- [app/api/access-code/verify/route.ts:6-41](file://app/api/access-code/verify/route.ts#L6-L41)
- [lib/server/access-token.ts:3-25](file://lib/server/access-token.ts#L3-L25)

## 功能模块清单
- OAuth 客户端工具（PKCE、State、Token 交换、JWT 解码、授权 URL 构建）
  - 职责：实现标准 OAuth 2.0 安全增强（PKCE）、CSRF 防护（state）、令牌交换与用户信息提取
  - 验收要点：code_verifier/challenge 生成符合规范；state 随机性；token 交换成功时返回完整字段；JWT 解码仅用于 payload 提取
- OIDC 配置发现与回退
  - 职责：从 /.well-known/openid-configuration 拉取端点，失败则回退环境变量构造默认端点；缓存配置减少请求
  - 验收要点：生产环境缓存生效；环境变量覆盖正确；回调地址拼接正确
- 会话 Cookie 签名与验证
  - 职责：服务端签名（Node crypto），Edge 兼容验证（Web Crypto API）；包含过期时间校验与必填字段检查
  - 验收要点：签名算法一致；HMAC 比较安全；过期判断准确；子域/路径/SameSite 策略合理
- **新增**无缝访问令牌验证
  - 职责：Edge 兼容的 HMAC-SHA256 验证，支持 Next.js middleware 中的无缝认证
  - 验收要点：verifyAccessTokenEdge 函数在 Edge Runtime 中正常工作；与 Node.js 版本产生相同签名
- **新增**GET-only 认证白名单机制
  - 职责：允许特定 GET 端点无需认证访问，同时保持速率限制防护
  - 验收要点：仅允许 GET 方法；应用适当的速率限制；保持页面级认证保护
- **新增**服务器到服务器认证支持
  - 职责：通过 Bearer Token 机制实现内部 API 通信，绕过 OAuth 认证流程
  - 验收要点：`/api/persistence` 端点支持 PERSISTENCE_DEV_TOKEN 认证；authenticatePersistenceRequest 函数正确验证请求
- **新增**公共资源静态文件服务
  - 职责：提供应用层 public/ 目录代理服务，解决 Next.js 16 + Turbopack 部署问题
  - 验收要点：路径白名单验证；目录遍历防护；MIME 类型映射；流式文件传输
- **新增**增强的错误处理机制
  - 职责：通过 ClassroomAuthError 哨兵错误精确区分认证失败与其他错误类型
  - 验收要点：401 错误被正确识别并抛出 ClassroomAuthError；其他错误类型正常处理
- 访问码鉴权（可选）
  - 职责：前端检测状态并弹出模态框；后端常量时间比较访问码；成功后下发短期访问令牌 Cookie
  - 验收要点：timingSafeEqual 防时序攻击；Cookie 安全属性正确；前端默认安全策略（失败即视为需认证）
- **新增**统一授权模型
  - 职责：代理中间件同时接受 OAuth session cookies 和 seamless access tokens，创建'或'授权模型
  - 验收要点：中间件优先检查 OAuth session，然后检查无缝 token；任一有效即可放行

**章节来源**
- [lib/server/oauth-client.ts:1-130](file://lib/server/oauth-client.ts#L1-L130)
- [lib/server/oauth-config.ts:1-81](file://lib/server/oauth-config.ts#L1-L81)
- [lib/server/session-cookie.ts:24-99](file://lib/server/session-cookie.ts#L24-L99)
- [lib/server/access-token.ts:27-71](file://lib/server/access-token.ts#L27-L71)
- [proxy.ts:91-117](file://proxy.ts#L91-L117)
- [app/api/public/[...path]/route.ts:52-97](file://app/api/public/[...path]/route.ts#L52-L97)
- [app/api/persistence/[...path]/route.ts:173-199](file://app/api/persistence/[...path]/route.ts#L173-L199)
- [lib/persistence/server-auth.ts:29-38](file://lib/persistence/server-auth.ts#L29-L38)
- [app/api/access-code/status/route.ts:6-31](file://app/api/access-code/status/route.ts#L6-L31)
- [app/api/access-code/verify/route.ts:6-41](file://app/api/access-code/verify/route.ts#L6-L41)
- [components/access-code-guard.tsx:16-38](file://components/access-code-guard.tsx#L16-L38)
- [components/access-code-modal.tsx:27-53](file://components/access-code-modal.tsx#L27-L53)

## 数据与状态
- 会话数据结构（SessionData）
  - 字段：sub、name、picture、access_token、refresh_token、expires_at
  - 作用：承载用户标识、头像、令牌及过期时间，用于后续 API 调用与刷新
- Cookie 命名与安全属性
  - 会话 Cookie：openmaic_session（httpOnly、secure 在生产启用、sameSite=lax、path=/、maxAge=30天）
  - 临时 OAuth Cookie：oauth_state、oauth_code_verifier、oauth_return_to（一次性，完成后清空）
  - **新增**无缝访问令牌：openmaic_access（httpOnly、sameSite=lax、path=/、maxAge=7天）
- 配置与密钥
  - OIDC 发现端点：OAUTH_ISSUER/.well-known/openid-configuration
  - Client 凭据：OAUTH_CLIENT_ID、OAUTH_CLIENT_SECRET
  - 回调地址：NEXT_PUBLIC_APP_URL 或 OAUTH_REDIRECT_URI
  - 会话密钥：OPENMAIC_SESSION_SECRET 或 ACCESS_CODE 或开发默认值
  - **新增**持久化存储令牌：PERSISTENCE_DEV_TOKEN（开发专用，编译到前端包中）
  - **新增**公共资源白名单：avatars、logos、vendor 目录前缀

```mermaid
classDiagram
class SessionData {
+string sub
+string name
+string picture
+string access_token
+string refresh_token
+number expires_at
}
class TokenResponse {
+string access_token
+string token_type
+number expires_in
+string id_token
+string refresh_token
+string scope
}
class IdTokenPayload {
+string sub
+string name
+string picture
+string email
+string aud
+string iss
+number exp
+number iat
+string nonce
}
class OidcConfig {
+string issuer
+string authorizationEndpoint
+string tokenEndpoint
+string userinfoEndpoint
+string jwksUri
}
class AccessToken {
+string timestamp
+string signature
+boolean isValid()
}
class ClassroomAuthError {
+string message
+string name
}
class PersistenceAuth {
+string PERSISTENCE_DEV_TOKEN
+function authenticatePersistenceRequest(req)
+RuntimeHttpPrincipal getPrincipal()
}
class PublicResource {
+string[] ALLOWED_PREFIXES
+Set ALLOWED_FILES
+function isPathSafe(parts)
+function serveFile(filePath)
}
```

**图表来源** 
- [lib/server/session-cookie.ts:15-22](file://lib/server/session-cookie.ts#L15-L22)
- [lib/server/oauth-client.ts:34-53](file://lib/server/oauth-client.ts#L34-L53)
- [lib/server/oauth-config.ts:11-17](file://lib/server/oauth-config.ts#L11-L17)
- [lib/server/access-token.ts:3-8](file://lib/server/access-token.ts#L3-L8)
- [lib/classroom/load-classroom.ts:28-34](file://lib/classroom/load-classroom.ts#L28-L34)
- [lib/persistence/server-auth.ts:29-38](file://lib/persistence/server-auth.ts#L29-L38)
- [app/api/public/[...path]/route.ts:39-43](file://app/api/public/[...path]/route.ts#L39-L43)

**章节来源**
- [lib/server/session-cookie.ts:15-22](file://lib/server/session-cookie.ts#L15-L22)
- [lib/server/oauth-client.ts:34-53](file://lib/server/oauth-client.ts#L34-L53)
- [lib/server/oauth-config.ts:11-17](file://lib/server/oauth-config.ts#L11-L17)
- [lib/server/access-token.ts:3-8](file://lib/server/access-token.ts#L3-L8)

## 关键约束与边界
- 安全约束
  - 必须使用 PKCE（S256）与随机 state 防止 CSRF 与授权码泄露
  - JWT 签名由上游 OIDC 保证，本侧仅做 payload 解码
  - 会话 Cookie 使用 HMAC-SHA256 签名，Edge/Node 两端一致性验证
  - 访问码校验采用常量时间比较，避免时序攻击
  - **新增**无缝访问令牌验证使用 Edge 兼容的 HMAC-SHA256 实现，确保在 Next.js middleware 中正常工作
  - **新增**GET-only 白名单仅允许 GET 方法，所有其他 HTTP 方法仍需完整认证
  - **新增**服务器到服务器认证使用 Bearer Token 机制，PERSISTENCE_DEV_TOKEN 仅用于开发环境
  - **新增**公共资源访问实施严格的路径白名单和目录遍历防护
- 依赖与集成边界
  - 依赖 Philochora OIDC 服务的 discovery 端点；若不可用则回退环境变量
  - 回调地址需与 OIDC 注册一致；支持同域与子路径部署
  - **新增**无缝认证依赖 Philochora 的 /api/openmaic/enter 端点颁发 openmaic_access token
  - **新增**教室数据访问依赖 nanoid 生成的不可猜测 ID，防止枚举攻击
  - **新增**持久化存储认证依赖 PERSISTENCE_DEV_TOKEN 环境变量
  - **新增**公共资源服务依赖 Next.js 16 + Turbopack 的 public/ 目录结构
- 业务约束
  - 访问码模式为可选开关，未启用时不强制认证
  - 会话有效期由 expires_at 控制，过期后需重新登录或刷新令牌
  - 生产环境建议开启 secure Cookie 与 SameSite=Lax
  - **新增**统一授权模型：OAuth session 和无缝 access token 任一有效即可通过认证
  - **新增**页面级认证保护保持不变，仅 API 数据层提供只读访问
  - **新增**增强的错误处理：认证失败抛出 ClassroomAuthError，便于前端精确处理
  - **新增**服务器到服务器认证仅适用于受信任的内部网络环境
  - **新增**公共资源服务仅支持预定义的白名单目录和文件类型

**章节来源**
- [lib/server/oauth-client.ts:10-23](file://lib/server/oauth-client.ts#L10-L23)
- [lib/server/oauth-client.ts:92-101](file://lib/server/oauth-client.ts#L92-L101)
- [lib/server/session-cookie.ts:70-99](file://lib/server/session-cookie.ts#L70-L99)
- [lib/server/access-token.ts:10-25](file://lib/server/access-token.ts#L10-L25)
- [lib/server/access-token.ts:51-71](file://lib/server/access-token.ts#L51-L71)
- [lib/server/oauth-config.ts:25-60](file://lib/server/oauth-config.ts#L25-L60)
- [proxy.ts:101-112](file://proxy.ts#L101-L112)
- [lib/server/classroom-storage.ts:53-55](file://lib/server/classroom-storage.ts#L53-L55)
- [lib/classroom/load-classroom.ts:28-34](file://lib/classroom/load-classroom.ts#L28-L34)
- [lib/persistence/server-auth.ts:1-13](file://lib/persistence/server-auth.ts#L1-L13)
- [app/api/public/[...path]/route.ts:44-50](file://app/api/public/[...path]/route.ts#L44-L50)

## GET-only 认证白名单详解

### 架构设计
GET-only 认证白名单机制允许未认证用户直接访问特定的只读 API 端点，主要用于教室数据的公开分享和媒体资源的直接访问。系统设计遵循"最小权限原则"，仅提供必要的只读访问能力。

```mermaid
sequenceDiagram
participant Client as "客户端"
participant Proxy as "代理中间件"
participant ClassroomAPI as "教室 API"
participant MediaAPI as "媒体 API"
Note over Client,MediaAPI : GET-only 白名单访问流程
Client->>Proxy : GET /api/classroom?id=nanoid_id
Proxy->>Proxy : 检查 isGetWhitelisted(pathname, method)
Proxy->>Proxy : 应用速率限制 (60 req/min)
Proxy->>ClassroomAPI : 转发请求 (无需认证)
ClassroomAPI-->>Proxy : 返回教室数据
Proxy-->>Client : 返回响应
Client->>Proxy : GET /api/classroom-media/ : id/ : path
Proxy->>Proxy : 检查 isGetWhitelisted(pathname, method)
Proxy->>Proxy : 应用速率限制
Proxy->>MediaAPI : 转发请求 (无需认证)
MediaAPI-->>Proxy : 返回媒体文件
Proxy-->>Client : 流式传输媒体数据
```

**图表来源** 
- [proxy.ts:101-116](file://proxy.ts#L101-L116)
- [app/api/classroom/route.ts:51-86](file://app/api/classroom/route.ts#L51-86)
- [app/api/classroom-media/[classroomId]/[...path]/route.ts:23-95](file://app/api/classroom-media/[classroomId]/[...path]/route.ts#L23-L95)

### 技术实现
- **白名单配置**：GET_AUTH_WHITELIST 数组定义允许的 GET 端点路径
- **方法验证**：isGetWhitelisted 函数确保仅允许 GET 方法
- **速率限制**：即使免认证访问，仍应用统一的速率限制策略
- **ID 验证**：isValidClassroomId 使用正则表达式验证 nanoid 格式
- **路径安全**：媒体端点实施严格的路径遍历防护

### 安全考虑
- **只读访问**：仅允许 GET 方法，禁止任何数据修改操作
- **不可猜测 ID**：使用 nanoid 生成的 10 字符 ID，防止枚举攻击
- **路径验证**：媒体端点严格验证文件路径，防止目录遍历
- **速率限制**：所有白名单端点都受速率限制保护
- **页面保护**：教室页面本身仍需认证，仅 API 数据层开放

### 前端集成
教室页面在加载时会尝试通过白名单 API 获取数据，如果认证失败但仍能访问数据端点，则可以直接渲染教室内容，提供更好的用户体验。

**章节来源**
- [proxy.ts:43-50](file://proxy.ts#L43-L50)
- [proxy.ts:72-74](file://proxy.ts#L72-L74)
- [proxy.ts:101-116](file://proxy.ts#L101-L116)
- [lib/server/classroom-storage.ts:53-55](file://lib/server/classroom-storage.ts#L53-L55)
- [app/api/classroom/route.ts:51-86](file://app/api/classroom/route.ts#L51-86)
- [app/api/classroom-media/[classroomId]/[...path]/route.ts:23-95](file://app/api/classroom-media/[classroomId]/[...path]/route.ts#L23-L95)

## 服务器到服务器认证详解

### 架构设计
服务器到服务器认证机制允许内部服务之间通过 Bearer Token 进行安全通信，绕过传统的 OAuth 认证流程。该机制特别适用于微服务架构中的内部 API 调用。

```mermaid
sequenceDiagram
participant Client as "内部服务"
participant Proxy as "代理中间件"
participant Persistence as "持久化存储"
Note over Client,Persistence : 服务器到服务器认证流程
Client->>Proxy : POST /api/persistence (Authorization : Bearer TOKEN)
Proxy->>Proxy : 检查 AUTH_WHITELIST (/api/persistence)
Proxy->>Proxy : 跳过 OAuth 认证
Proxy->>Persistence : 转发请求 (保留 Bearer Token)
Persistence->>Persistence : authenticatePersistenceRequest()
Persistence->>Persistence : 验证 PERSISTENCE_DEV_TOKEN
Persistence-->>Proxy : 返回持久化数据
Proxy-->>Client : 返回响应
```

**图表来源** 
- [proxy.ts:35-42](file://proxy.ts#L35-L42)
- [app/api/persistence/[...path]/route.ts:173-199](file://app/api/persistence/[...path]/route.ts#L173-L199)
- [lib/persistence/server-auth.ts:29-38](file://lib/persistence/server-auth.ts#L29-L38)

### 技术实现
- **白名单配置**：`/api/persistence` 添加到 AUTH_WHITELIST，完全跳过 OAuth 认证
- **Bearer Token 验证**：authenticatePersistenceRequest 函数验证 Authorization 头中的 Bearer Token
- **环境变量配置**：PERSISTENCE_DEV_TOKEN 环境变量存储共享密钥
- **安全比较**：使用 timingSafeEqual 防止时序攻击
- **开发者友好**：支持 x-learner-key 头部指定学习者分区

### 安全考虑
- **开发专用**：PERSISTENCE_DEV_TOKEN 会编译到前端包中，仅适用于受信任的网络环境
- **令牌安全**：使用 SHA256 哈希和常量时间比较确保安全性
- **网络隔离**：仅适用于 localhost 或可信网络部署
- **生产替代**：生产环境需要替换为真正的会话验证机制

### 前端集成
内部服务在调用持久化存储 API 时，需要在 Authorization 头中携带 Bearer Token，格式为 `Bearer ${PERSISTENCE_DEV_TOKEN}`。

**章节来源**
- [proxy.ts:35-42](file://proxy.ts#L35-L42)
- [app/api/persistence/[...path]/route.ts:173-199](file://app/api/persistence/[...path]/route.ts#L173-L199)
- [lib/persistence/server-auth.ts:29-38](file://lib/persistence/server-auth.ts#L29-L38)

## 公共资源静态文件服务详解

### 架构设计
公共资源静态文件服务为 Next.js 16 + Turbopack 部署模式提供应用层 public/ 目录代理服务，解决 basePath 部署时的静态资源访问问题。系统通过严格的路径白名单和安全验证确保资源访问的安全性。

```mermaid
sequenceDiagram
participant Browser as "浏览器"
participant Proxy as "代理中间件"
participant PublicRoute as "public 路由"
Note over Browser,PublicRoute : 公共资源访问流程
Browser->>Proxy : GET /api/public/logos/logo.png
Proxy->>Proxy : 检查 AUTH_WHITELIST (/api/public)
Proxy-->>Browser : 跳过 OAuth 认证
Browser->>PublicRoute : GET /api/public/logos/logo.png
PublicRoute->>PublicRoute : 验证路径安全性
PublicRoute->>PublicRoute : 检查白名单前缀
PublicRoute->>PublicRoute : 读取 public/ 目录文件
PublicRoute-->>Browser : 返回静态文件 (流式传输)
```

**图表来源** 
- [proxy.ts:35-43](file://proxy.ts#L35-L43)
- [app/api/public/[...path]/route.ts:52-97](file://app/api/public/[...path]/route.ts#L52-L97)

### 技术实现
- **白名单配置**：AUTH_WHITELIST 包含 `/api/public` 路径，完全跳过 OAuth 认证
- **路径验证**：isPathSafe 函数验证路径组件，防止目录遍历攻击
- **前缀白名单**：ALLOWED_PREFIXES 限制可访问的目录前缀（avatars、logos、vendor）
- **文件白名单**：ALLOWED_FILES 支持特定文件的直接访问
- **MIME 类型映射**：MIME_BY_EXT 对象提供正确的 Content-Type 响应头
- **流式传输**：使用 Node.js 流避免大文件内存占用

### 安全考虑
- **路径白名单**：仅允许预定义的公共资源前缀和文件
- **目录遍历防护**：双重验证确保文件路径在 public/ 目录下
- **方法限制**：仅支持 GET 方法，其他方法返回 405
- **文件大小限制**：通过 statSync 验证文件存在性和类型
- **缓存控制**：设置合理的 Cache-Control 头优化性能

### 部署兼容性
- **开发模式**：解决 Next.js 16 + Turbopack 的 basePath 部署问题
- **生产模式**：作为冗余服务，Next.js 自身也能正确处理 public/ 资源
- **独立部署**：对 basePath 为空的情况无副作用

**章节来源**
- [proxy.ts:35-43](file://proxy.ts#L35-L43)
- [app/api/public/[...path]/route.ts:1-106](file://app/api/public/[...path]/route.ts#L1-L106)

## 增强的错误处理机制

### ClassroomAuthError 哨兵错误
系统引入了专门的 ClassroomAuthError 类来精确区分认证失败与其他类型的错误，提供更清晰的错误处理和用户反馈。

```mermaid
sequenceDiagram
participant Client as "客户端"
participant LoadClassroom as "loadClassroom"
participant API as "教室 API"
Note over Client,API : 认证错误处理流程
Client->>LoadClassroom : 调用 loadClassroom(classroomId)
LoadClassroom->>API : 获取教室数据
API-->>LoadClassroom : 返回 401 认证失败
LoadClassroom->>LoadClassroom : 抛出 ClassroomAuthError
LoadClassroom-->>Client : 传播认证错误
Client->>Client : 显示认证过期提示
Client->>Client : 提供重试选项
```

**图表来源** 
- [lib/classroom/load-classroom.ts:210-245](file://lib/classroom/load-classroom.ts#L210-L245)

### 技术实现
- **错误分类**：HTTP 401 状态码被识别为认证失败，抛出 ClassroomAuthError
- **错误传播**：认证错误被正确传播到调用方，而不是被静默处理
- **用户反馈**：前端可以捕获 ClassroomAuthError 并提供具体的错误消息和操作选项
- **兼容性**：其他类型的错误继续按原有方式处理，不影响现有功能

### 前端集成
前端组件可以捕获 ClassroomAuthError 并显示相应的用户友好提示，如"认证已过期，请重新进入教室"，并提供重试按钮让用户重新尝试。

**章节来源**
- [lib/classroom/load-classroom.ts:28-34](file://lib/classroom/load-classroom.ts#L28-L34)
- [lib/classroom/load-classroom.ts:210-245](file://lib/classroom/load-classroom.ts#L210-L245)

## 无缝认证集成详解

### 架构设计
无缝认证系统允许已通过 Philochora SSO 认证的用户直接进入 OpenMAIC 教室，无需重复登录。系统采用"或"授权模型，同时支持传统 OAuth session 和新的无缝 access token。

```mermaid
sequenceDiagram
participant User as "用户"
participant Philochora as "Philochora SSO"
participant OpenMAIC as "OpenMAIC 应用"
participant Proxy as "代理中间件"
Note over Philochora,OpenMAIC : 无缝认证流程
Philochora->>OpenMAIC : /api/openmaic/enter
OpenMAIC->>OpenMAIC : 验证用户身份
OpenMAIC->>User : 设置 openmaic_access cookie
User->>Proxy : 访问受保护资源
Proxy->>Proxy : 检查 openmaic_session
alt 无有效 session
Proxy->>Proxy : 检查 openmaic_access token
Proxy->>Proxy : verifyAccessTokenEdge(token, accessCode)
end
Proxy-->>User : 允许访问
```

**图表来源** 
- [proxy.ts:101-112](file://proxy.ts#L101-L112)
- [lib/server/access-token.ts:51-71](file://lib/server/access-token.ts#L51-L71)

### 技术实现
- **Edge 兼容验证**：verifyAccessTokenEdge 函数使用 Web Crypto API 而非 Node.js crypto，确保在 Next.js middleware 环境中正常工作
- **常量时间比较**：使用位运算 XOR 实现安全的字符串比较，防止时序攻击
- **统一授权逻辑**：代理中间件优先检查 OAuth session，然后检查无缝 access token，任一有效即可放行

### 前端集成
访问码状态端点已更新以识别两种认证方法，修复了仅具有 OAuth session 的用户被 AccessCodeModal 错误阻止的问题。

**章节来源**
- [proxy.ts:101-112](file://proxy.ts#L101-L112)
- [lib/server/access-token.ts:51-71](file://lib/server/access-token.ts#L51-L71)
- [app/api/access-code/status/route.ts:17-27](file://app/api/access-code/status/route.ts#L17-L27)

## 认证白名单架构详解

### 白名单类型对比
系统现在支持四种不同类型的认证白名单，每种都有特定的用途和安全级别：

| 白名单类型 | 路径示例 | 认证要求 | 用途 |
|-----------|----------|----------|------|
| AUTH_WHITELIST | `/api/persistence`, `/api/auth/callback`, `/api/public` | 完全跳过认证 | 特殊端点，自带独立认证机制或公共资源 |
| GET_AUTH_WHITELIST | `/api/classroom`, `/api/classroom-media/` | 仅 GET 方法免认证 | 只读数据访问，带速率限制 |
| 普通 API | 其他 `/api/*` 路径 | 完整 OAuth 认证 | 需要用户会话的 API 端点 |

### 认证流程决策树
```mermaid
flowchart TD
Request["收到请求"] --> CheckPath{"检查路径"}
CheckPath --> AuthWhitelist{"在 AUTH_WHITELIST?"}
CheckPath --> GetWhitelist{"在 GET_AUTH_WHITELIST?"}
CheckPath --> NormalAPI{"普通 API"}
AuthWhitelist -- 是 --> SkipAuth["跳过认证"]
AuthWhitelist -- 否 --> GetWhitelist
GetWhitelist -- 是 --> CheckMethod{"检查方法"}
GetWhitelist -- 否 --> NormalAPI
CheckMethod -- GET --> RateLimit["应用速率限制"]
CheckMethod -- 其他 --> NormalAPI
RateLimit --> SkipAuth
NormalAPI --> OAuthCheck{"检查 OAuth 会话"}
OAuthCheck -- 有效 --> ServiceKey{"检查服务密钥"}
OAuthCheck -- 无效 --> SeamlessCheck{"检查无缝令牌"}
ServiceKey -- 有效 --> Allow["允许访问"]
ServiceKey -- 无效 --> SeamlessCheck
SeamlessCheck -- 有效 --> Allow
SeamlessCheck -- 无效 --> Redirect["重定向到 OAuth"]
```

**图表来源** 
- [proxy.ts:35-51](file://proxy.ts#L35-L51)
- [proxy.ts:77-83](file://proxy.ts#L77-L83)
- [proxy.ts:101-132](file://proxy.ts#L101-L132)

### 安全最佳实践
- **最小权限原则**：每个白名单项都应明确其必要性和安全影响
- **方法限制**：GET-only 白名单严格限制 HTTP 方法
- **速率限制**：所有免认证访问都应用速率限制
- **环境变量管理**：敏感令牌应通过环境变量管理，避免硬编码
- **开发/生产分离**：开发专用功能应与生产环境隔离
- **路径验证**：公共资源访问实施严格的路径白名单和目录遍历防护

**章节来源**
- [proxy.ts:35-51](file://proxy.ts#L35-L51)
- [proxy.ts:77-83](file://proxy.ts#L77-L83)
- [proxy.ts:101-132](file://proxy.ts#L101-L132)
- [lib/persistence/server-auth.ts:1-13](file://lib/persistence/server-auth.ts#L1-L13)
- [app/api/public/[...path]/route.ts:44-50](file://app/api/public/[...path]/route.ts#L44-L50)