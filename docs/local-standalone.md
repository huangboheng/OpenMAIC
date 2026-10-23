# OpenMAIC 本地单独运行指南

- **版本**：1.0
- **创建/更新**：2026-10-24
- **适用**：本仓库 `custom-main`（1.2.7+）
- **关联**：[ADR-0003](adr/0003-local-access-code-auth-mode.md)、[ADR-0002](adr/0002-home-page-exposure.md)

## 目录

1. [适用范围](#1-适用范围)
2. [前置条件](#2-前置条件)
3. [配置](#3-配置)
4. [启动与登录](#4-启动与登录)
5. [数据库选择](#5-数据库选择)
6. [验证清单](#6-验证清单)
7. [故障排查](#7-故障排查)
8. [边界与限制](#8-边界与限制)

## 1. 适用范围

本指南让 OpenMAIC 在本机以 **access-code 独立模式** 运行：不依赖 Philochora OAuth，打开首页后输入访问码即可使用生成流程和课堂页。托管部署（`philochora.com/openmaic`）继续走 OAuth，不适用本指南。

## 2. 前置条件

| 依赖 | 要求 |
| --- | --- |
| Node.js | `>= 22.19.0`（`package.json` engines） |
| pnpm | `10.28.0`（`packageManager`） |
| PostgreSQL | 可连接的实例；本地 5432 或 Compose 独立端口 |
| LLM | `.env.local` 中至少一个可用 provider/key |

## 3. 配置

在 `.env.local` 中设置：

```env
DATABASE_URL=postgresql://<user>:<password>@localhost:5432/<database>
ACCESS_CODE=<至少 16 位随机字符串>

OPENMAIC_HOME_ENABLED=true
OPENMAIC_AUTH_MODE=access-code
OWNER_SINGLE_USER=true
OWNER_SINGLE_USER_ID=local
```

说明：

- `OPENMAIC_AUTH_MODE` 是 server-only，默认 `oauth`；只有 `access-code` 且 `ACCESS_CODE` 非空才会进入本地模式。
- access-code 模式不使用 `OAUTH_ISSUER`、`OAUTH_CLIENT_ID`、`OAUTH_CLIENT_SECRET`，可以把它们注释掉。
- `OWNER_SINGLE_USER=true` 与 `PERSISTENCE_SHARED_OWNER_ID` 互斥，不能同时设置。
- 不要使用 `NEXT_PUBLIC_*` 保存访问码。

## 4. 启动与登录

```bash
pnpm dev
```

打开 **http://localhost:3000/openmaic**：

1. 出现“请输入访问码”弹窗；输入 `.env.local` 的 `ACCESS_CODE`。
2. 登录成功后写入 HttpOnly 的 `openmaic_access` cookie，有效期 7 天。
3. 首页、生成流程、`/generation-preview`、课堂页均可访问；刷新不需要重新输入。
4. 清空 cookie 后弹窗回归。

## 5. 数据库选择

**A. 沿用已有数据库（默认）**

直接使用本机 `DATABASE_URL` 指向的库。OpenMAIC 的 schema 会在首次启动时自动创建；已有 `legacy_classroom_imports` 记录时不会重复导入 `data/classrooms`。

**B. 独立数据库**

在同一 PostgreSQL 中新建数据库（推荐 `openmaic_local`），把 `DATABASE_URL` 指过去。首次启动会自动建表，并把 `data/classrooms` 的 193 个课堂导入到 `system:legacy-classrooms`（若在首次启动前设置 `OWNER_SINGLE_USER=true`，固定 owner 规则以启动时配置为准）。也可以在 5433 端口用 Compose 独立实例：

```bash
OPENMAIC_DB_PORT=5433 pnpm db:up
# DATABASE_URL=postgres://openmaic:openmaic-dev@127.0.0.1:5433/openmaic
pnpm db:down   # 停止并保留数据
```

注意：5432 已被其他 PostgreSQL 占用时，`pnpm db:up` 需要显式换端口，且 `OPENMAIC_DB_PORT` 要放在 shell 或 Compose 同级 `.env`，不是 `.env.local`。

### 5.1 沿用旧共享库时的触发器修复

如果 `DATABASE_URL` 指向包含 Philochora 旧表的共享库，且 `document_stages.updated_at` 是 `double precision`，需要删除遗留的 `set_updated_at` 触发器；否则课堂保存会 500（`invalid input syntax for type double precision`）：

```sql
-- 只删 OpenMAIC 表上的陈旧触发器；不要删除 set_updated_at() 函数（旧表仍在使用）
drop trigger if exists trg_document_stages_updated_at on document_stages;
```

执行后重新保存/生成课堂。新建的 OpenMAIC 库通常没有这条遗留触发器。

## 6. 验证清单

```bash
# 页面与访问码端点
curl -i http://localhost:3000/openmaic
curl -i http://localhost:3000/openmaic/api/access-code/status

# 未登录业务 API 应为 401
curl -i http://localhost:3000/openmaic/api/stages

# 验证码换取 cookie（把 <code> 替换为本地访问码）
curl -i -X POST http://localhost:3000/openmaic/api/access-code/verify \
  -H 'content-type: application/json' -d '{"code":"<code>"}'
```

浏览器端：

- [ ] 首屏出现访问码弹窗；错误码保留弹窗并清空输入。
- [ ] 正确码后首页加载，`/api/stages` 返回 200。
- [ ] 能生成并打开一堂短课；刷新后仍可访问。
- [ ] `stage_meta.owner_id` 为新课堂记录 `local`。
- [ ] 从 `data/classrooms` 取一个 id，登录后 `/openmaic/classroom/<id>` 可打开。
- [ ] 清空 cookie 后弹窗回归。

## 7. 故障排查

| 现象 | 检查 |
| --- | --- |
| 一直 401 / 不弹窗 | `OPENMAIC_AUTH_MODE` 是否为 `access-code`，`ACCESS_CODE` 是否非空；改 env 后重启进程 |
| 启动报 `[boot]` 配置错误 | 模式拼写只能是 `access-code`/`oauth`；access-code 必须有 `ACCESS_CODE` |
| 登录成功但子页 307 到 OAuth | 服务端未加载 access-code 模式；确认进程 env，而不是只改了 `.env.local` 后未重启 |
| `pnpm start`（HTTP）登录后 cookie 丢失 | `NODE_ENV=production` 会给 cookie 加 Secure；本地 HTTP 临时用 `COOKIE_SECURE=0` |
| 首页课程库为空 | 单用户库是 `local`；匿名 owner 的旧课程只有原浏览器可 claim；193 legacy 课堂不在库内 |
| 生成报 `LLM returned empty response` | 检查 `DEFAULT_MODEL` 指向的 provider/key 是否有效；reasoning 模型在低 token 预算下可能只返回 `reasoning_content`，改用返回普通 `content` 的模型或提高预算 |
| TTS/图片报 `UnsafeNetworkTargetError` | 本机 DNS/代理把 provider 域名解析到内网地址；本地设 `ALLOW_LOCAL_NETWORKS=true`（含 Clash fake-IP 198.18.0.0/15），公网部署不要开启 |
| MiniMax 余额不足 | 停用 `TTS_MINIMAX_*`/`IMAGE_MINIMAX_*`，改用 `TTS_QWEN_*`（qwen3-tts-flash）与 `IMAGE_QWEN_IMAGE_*`（qwen-image-2.0-pro 等）；TTS 会回退到单音色 |
| 课堂保存/刷新 500，日志 `invalid input syntax for type double precision` | 共享旧库遗留触发器；执行 5.1 的 `drop trigger ... on document_stages` |
| 5432 端口被占用 | `OPENMAIC_DB_PORT=5433 pnpm db:up`，并改 `DATABASE_URL` |
| 页面请求 404 | 托管模式下仅课堂页可达；本地需 `OPENMAIC_HOME_ENABLED=true` |

## 8. 边界与限制

- access-code 模式页面壳公开，业务 API 仍鉴权；面向 localhost/私网，公网部署请使用长随机码并置于反向代理后。
- MiniMax 不可用时，TTS 走已配置 provider 的单音色回退（当前为 qwen-tts），课堂没有四音色切换；图片使用 `IMAGE_QWEN_IMAGE_*`。
- 访问码 verify 的尝试限流仅在 `TRUST_PROXY_HEADERS=true` 时按 IP 生效；单机直连时长码是主要防护。
- `openmaic_access` cookie 与 OAuth 的 `openmaic_session` 是两条独立凭据；本地模式不需要配置 OAuth。
- 本指南不改变托管部署的 nginx/API 白名单契约；托管仍默认 `oauth`。
