# API Key 所有者清单（Key Owners Roster）

> 配套：[api-key-model.md](./api-key-model.md)
> 维护责任：项目 owner（轮换、吊销、新增时同步更新本表）
> 上次审计：2026-08-18

## Top-10 密钥清单

| Provider | Environment | Owner | Fingerprint (前缀) | Last Rotated | Next Rotate | Scope | Status |
|----------|-------------|-------|--------------------|--------------|-------------|-------|--------|
| DeepSeek (LLM) | dev | huangboheng@ | (待 inventory) | 2026-07-31* | 2026-10-31 | read+write | **active (泄漏)** |
| DeepSeek (LLM) | prod | huangboheng@ | (待 inventory) | 2026-07-31* | 2026-10-31 | read+write | **active (泄漏)** |
| MiniMax TTS | dev+prod | huangboheng@ | sk-cp-BQmc... | 2026-08-01 | 2026-11-01 | read+write | active |
| Bocha Web Search | dev+prod | huangboheng@ | (待 inventory) | 2026-08-01 | 2026-11-01 | read | active |
| DashScope ASR | dev+prod | huangboheng@ | (待 inventory) | 2026-08-01 | 2026-11-01 | read+write | active |
| Qwen LLM (备用) | dev+prod | huangboheng@ | (待 inventory) | 2026-08-01 | 2026-11-01 | read+write | active |
| OPENMAIC_SERVICE_API_KEY | cross-repo | (待指派) | (待 inventory) | (待定) | (待定) | service | active |
| OPENMAIC_SHARED_SECRET | cross-repo | (待指派) | (待 inventory) | (待定) | (待定) | service | active |
| OAUTH_CLIENT_SECRET | cross-repo | (待指派) | (待 inventory) | (待定) | (待定) | service | active |
| ACCESS_CODE (Philochora 前端) | prod | huangboheng@ | philochora-openmaic-2026 | 2026-01-01 | 2027-01-01 | service | active |

\* 标记"泄漏"的密钥需按 IR Playbook 立即处置（参考 [incident-response-playbook.md](./incident-response-playbook.md)）。

## 已知泄漏（2026-08-18 历史回扫发现）

**DeepSeek × 3 keys** — 提交者 `huangboheng`，提交 hash `4978500c`，日期 2026-07-31：

```
sk-d091544c04814dd0b7278001c0c4b481
sk-eb94751ddfed408d8bcc266e15c6aa78
sk-9061ddf282684c02bf4a2158250e5030
```

**处置建议**（参考 IR Playbook）：
1. 立即在 DeepSeek 控制台吊销上述 3 个 key
2. 重新生成 3 个新 key
3. 用 `git filter-repo --blob-callback` 清理 `scripts/run-translation.mjs` 历史
4. 部署新 key 到 `.env.local` 和 `.env.vps.local`
5. 更新本 roster 状态为 `retired`

## Owner 指派规则

| 角色 | 责任 |
|---|---|
| 项目 owner | 主要 Provider 的密钥 owner；轮换 / 吊销的执行者 |
| 部署运维 | VPS 部署相关密钥的 owner；BILIBILI_SESSDATA 等 |
| 安全负责人 | 密钥泄漏应急响应 owner（IR Playbook 启动者） |

> **TODO**：当前仅 owner 邮箱被记录；后续 BR 中需明确安全负责人 + 部署运维两个角色。

## 轮换 SLA

| 触发条件 | SLA |
|---|---|
| 定期轮换（90 天） | 7 天内完成 |
| 发现泄漏 | 30 min 内吊销 + 24h 内轮换 |
| Provider 通告主密钥更新 | 7 天内轮换 |
| Owner 离职 | 立即吊销 + 轮换 |

## 维护流程

每次新增 / 轮换 / 吊销密钥，必须：
1. 更新本表（provider / env / owner / fingerprint 前缀 / rotated 日期 / 状态）
2. 在 [api-key-model.md](./api-key-model.md) 中更新对应章节
3. 双仓共享密钥需同时更新两份 roster
4. 在 `.clay/CHANGES/BR-XXX-key-rotation/` 下创建变更记录

## 更新日志

- 2026-08-18：初版（plan 阶段 4 v2），Top-10 密钥清单 + 已知泄漏登记