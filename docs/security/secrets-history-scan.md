# Secrets 历史扫描使用文档

> 适用项目：OpenMAIC + Philochora（双仓统一工具链）
> 配套脚本：`scripts/check-secrets-history.mjs`
> 上游规则：`lib/secrets-scanner.mjs`（与 pre-commit 共享）
> 治理规则：`.qoder/rules/secrets-scan.md`

## 用途

`check-secrets.mjs` 只看新增变更，**无法检测已经泄漏到 git 历史中的密钥**。本脚本扫描 `git log -p` 输出，对每个 commit 的新增行做同样规则匹配。

## 用法

```bash
# 扫描最近 24 个月（默认）
node scripts/check-secrets-history.mjs

# 扫描最近 1 个月
node scripts/check-secrets-history.mjs --months 1

# 扫描指定 commit 之后
node scripts/check-secrets-history.mjs --since abc1234

# 扫描指定 ref 之后（默认 HEAD）
node scripts/check-secrets-history.mjs --ref main

# 限制最多扫描 commit 数（防止大仓库超时）
node scripts/check-secrets-history.mjs --max-commits 5000

# JSON 输出（CI / 工具消费）
node scripts/check-secrets-history.mjs --json
```

## 输出格式

每条命中包含：
- `id` — 命中的 pattern ID（openai-sk / deepseek-sk / aliyun-ak / ...）
- `commit` — 完整 commit hash（40 字符）
- `author` / `date` — 提交者与提交时间
- `path` — 文件路径
- `line` — 行号
- `match` — 命中的密钥片段（前 40 字符）
- `snippet` — 上下文行（前 160 字符）

## 已知泄漏案例（2026-08-18 历史回扫发现）

> ⚠️ **本节记录在文档初始化时已发现的真实泄漏**，需要在 .clay/CHANGES 下开 BR 处理。

| Commit | Date | File | Line | Pattern | Status |
|---|---|---|---|---|---|
| `4978500c` | 2026-07-31 | `scripts/run-translation.mjs` | 37-39 | deepseek-sk | **未处理** |
| `4978500c` | 2026-07-31 | `scripts/run-translation.mjs` | 37-39 | openai-sk（误报同源） | — |
| `4978500c` | 2026-07-31 | `scripts/run-translation.mjs` | 37-39 | dashscope-sk（误报同源） | — |

具体密钥值（已发现）：
```
sk-d091544c04814dd0b7278001c0c4b481
sk-eb94751ddfed408d8bcc266e15c6aa78
sk-9061ddf282684c02bf4a2158250e5030
```

**处置建议**（参考 IR Playbook）：
1. 立即在 DeepSeek 控制台吊销上述 3 个 key
2. 重新生成 3 个新 key
3. 用 `git filter-repo --blob-callback` 清理 `scripts/run-translation.mjs` 的相关行
4. 强制推送（与协作者充分沟通后）
5. 部署新 key 到所有环境

> **不要在文档中直接列出密钥值**——本节保留作为"已知泄漏"档案，密钥部分作为后续审计追踪。修复完成后密钥段应改为"已轮换"。

## 误报过滤

与 `check-secrets.mjs` 共享同一份 allowlist：
- `.env.example` / `*.example`
- `*.test.ts` / `*.spec.ts`
- 自身脚本（自指）

但历史扫描有个特殊情况：**已经合并到 main 的 PR 中如果包含错误密钥，无法通过新增 commit 修复，必须走历史清理路径**。

## 性能与超时

- 大仓库（> 10000 commit）建议配合 `--max-commits` 限制
- 单次扫描时间复杂度 O(commit × diff 行数 × pattern 数)
- CI 中建议加 `timeout: 300s` 防止 OOM

## CI 集成

参见 `.github/workflows/secrets-scan.yml`（阶段 2 计划）：
- PR 触发：`check-secrets.mjs --all-files`（扫描工作区）
- 每日定时：`check-secrets-history.mjs --months 3`（3 个月滚动扫描）

## 限制

- 不会扫描 force-push 前的历史（git 本身的限制）
- 不会扫描未 push 的本地 commit（`git log` 默认不含本地未推送）
- 不会扫描 `git stash` 中的内容

如果担心本地未推送 commit 泄漏，可手动跑：
```bash
git stash list
git stash show -p stash@{0}
```

## 相关文档

- `.qoder/rules/secrets-scan.md` — 强制规则
- `docs/security/incident-response-playbook.md` — 应急响应预案
- `docs/security/api-key-model.md` — APIKey 领域模型（阶段 4）
