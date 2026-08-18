---
alwaysApply: true
---

# Secrets 扫描强制规则

提交前必须由 `scripts/check-secrets.mjs` 自动扫描暂存区，防止真实 API KEY / Token / 凭据误入仓库。

## 扫描覆盖范围

`scripts/check-secrets.mjs` 内置以下规则（与 plan 阶段 1 对齐）：

| 模式 ID | 形态 | Provider |
|---|---|---|
| `openai-sk` | `sk-proj-...` / `sk-...` | OpenAI |
| `anthropic-sk` | `sk-ant-...` | Anthropic |
| `deepseek-sk` | `sk-[0-9a-f]{32}` | DeepSeek |
| `dashscope-sk` | `sk-[0-9a-f]{32}` | 阿里云百炼 |
| `minimax-cp` | `sk-cp-[A-Za-z0-9]{40,}` | MiniMax |
| `bocha-sk` | `sk-[0-9a-f]{32}` | Bocha |
| `aliyun-ak` | `AKID[A-Z0-9]{16,}` | 阿里云 AccessKey |
| `aws-access-key` | `AKIA/ASIA[A-Z0-9]{16}` | AWS |
| `github-pat` | `gh[pousr]_...` | GitHub |
| `slack-token` | `xox[abprs]-...` | Slack |
| `generic-key-value` | `api_key/token/secret = ...` | 通用 |
| `bearer-token` | `Bearer sk-...` | HTTP 头 |
| `next-public-secret` | `NEXT_PUBLIC_*KEY/TOKEN/SECRET = ...` | Next.js 前端泄漏 |

## 阻断触发条件

- **staged 变更文件**：命中任一规则 → 阻断 `git commit`
- **CI（GitHub Actions）**：扫描工作区全部文件 → 阻断 PR 合并
- **历史回扫（`check-secrets-history.mjs`）**：扫描 `git log -p` 最近 24 个月

## 逃生口（BR-087 留痕风格一致）

| 逃生口 | 用途 | 留痕 |
|---|---|---|
| `SECRETS_SCAN_APPROVED=1 git commit` | 显式审批放行（已知误报） | 写入 commit message；Philochora 写入 `.githooks/clay/skip-audit.log` |
| `SECRETS_SCAN_DISABLED=1 git commit` | 跳过本次扫描 | 必须配合 `SKIP_REASON="..."` |

## 误报防护（allowlist 内置）

- `.env.example` / `*.example` —— 仅含占位符的模板
- `*.test.ts` / `*.spec.ts` —— 测试 fixture
- `docs/`、`*.md` 扩展名 —— 纯文档
- `scripts/check-secrets.mjs` 自身（自指）

新增 allowlist 需在 PR 中说明理由。

## 不变量（Invariants）

1. 真实 API KEY 永远只能存在于 `.env.local` / `.env.vps.local` / `.env.secrets` / KMS 中
2. `.env.example` / `.env.example.template` 仅含占位符（`change-me-to-...`、`sk-your-...`）
3. 任何 `NEXT_PUBLIC_*KEY*` / `*TOKEN*` / `*SECRET*` 非空值都视为高风险（即使未匹配具体 provider 模式）
4. Bearer Token、Authorization 头、`api_key = ...` 等通用赋值不豁免
5. 双仓（OpenMAIC + Philochora）共享同一份扫描规则实现，确保一致性

## 验证命令

```bash
# 自测（占位符零命中）
node scripts/check-secrets.mjs --self-test

# 扫描 staged 变更
git add -A && node scripts/check-secrets.mjs

# 扫描整个工作区（CI 用）
node scripts/check-secrets.mjs --all-files

# 调试单文件
node scripts/check-secrets.mjs --scan-file <path>

# 历史回扫
node scripts/check-secrets-history.mjs
```

## 配套脚本

| 脚本 | 阶段 | 用途 |
|---|---|---|
| `scripts/check-secrets.mjs` | 1 | pre-commit 扫描（staged） |
| `scripts/check-secrets.mjs --all-files` | 2 | CI 扫描（全工作区） |
| `scripts/check-secrets-history.mjs` | 2 | git 历史回扫 |

## 触发场景

| 场景 | 处理 |
|---|---|
| 新增 `.env*` 文件含真实 KEY | 扫描命中 → 阻断；改为 `.env.example` 占位符 |
| 新增依赖包要求 AK/SK | 扫描命中 → 阻断；改用 RAM 角色或运行时注入 |
| 前端误用 `NEXT_PUBLIC_*KEY` | 扫描命中 → 阻断；改用服务端代理 |
| 测试 fixture 含真实 key | 扫描命中 → 阻断；改用 mock key 或加 allowlist（须评审） |
| 旧 commit 含泄漏 key | 历史回扫命中 → 触发 IR Playbook：吊销 + 轮换 + 历史清理 |
