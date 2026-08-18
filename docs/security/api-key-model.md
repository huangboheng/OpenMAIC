# APIKey 领域模型

> 配套 plan：阶段 4（D1-D5）
> 适用范围：OpenMAIC + Philochora 双仓统一
> 治理规则：`.qoder/rules/secrets-scan.md`

## 目标

把"密钥"从字符串提升为一等公民领域实体。明确：
- 密钥生命周期（创建、轮换、吊销、退役）
- 环境维度（dev / staging / prod）
- 所有者（owner）
- 状态机（active / rotating / retired / revoked）

## 实体定义（APIKey）

```ts
// 概念性 schema（不直接落库，仅作设计契约）
interface APIKey {
  id: string;                      // 'minimax-tts-prod-2026-08'
  provider: 'minimax' | 'deepseek' | 'bocha' | 'openai' | ...;
  environment: 'dev' | 'staging' | 'prod';
  owner: string;                   // 邮箱或工号
  scope: 'read' | 'write' | 'admin';
  fingerprint: string;             // sha256(key).slice(0, 16)（T1 修正后）
  status: 'active' | 'rotating' | 'retired' | 'revoked';
  createdAt: ISODate;
  lastRotatedAt: ISODate;
  rotateIntervalDays: number;      // 默认 90
  notes?: string;                  // 备注（如：被泄漏、原因）
}

// 注意：value 不进模型。密钥值永远只活在 .env* / KMS
```

## 状态机

```
active ───(手动轮换)──→ rotating ───(新 key 部署)──→ retired
   │
   └──(发现泄漏)──→ revoked ───(24h)──→ retired
```

- `active`：当前部署中使用的密钥，可被任意模块调用
- `rotating`：正在轮换过程中（已生成新 key，但新旧 key 并存用于灰度）；不可超过 7 天
- `retired`：已退役，新部署不再使用；保留 30 天供审计
- `revoked`：发现泄漏或异常，已吊销；立即从所有环境移除

## 生命周期 SOP

### 创建新 key

1. 在 provider 控制台生成新 key
2. 立即登记到 `key-owners-roster.md`
3. 部署到目标环境的 `.env*`
4. status 设为 `active`
5. 启动时校验调用是否成功

### 轮换（按 `rotateIntervalDays` 触发）

1. `node scripts/rotate-keys.mjs` 列出待轮换清单
2. 在 provider 控制台生成新 key（不删除旧 key）
3. 部署新 key 到目标环境（双仓同步：B6）
4. status 切换为 `rotating`
5. 等待 24h 灰度（监控旧 key 是否被使用）
6. 删除旧 key（provider 控制台）
7. status 切换为 `active`，更新 `lastRotatedAt`

### 吊销（发现泄漏）

1. 立即在 provider 控制台删除 key
2. status 切换为 `revoked`
3. 从所有环境 `.env*` 移除
4. **24h 后** status 切换为 `retired`
5. 触发 IR Playbook（[incident-response-playbook.md](./incident-response-playbook.md)）

## 环境维度分离（D3 强制）

当前所有 provider 必须按环境分 key：

| Provider | dev | staging | prod |
|---|---|---|---|
| minimax | dev-key-1 | staging-key-2 | prod-key-3 |
| deepseek | dev-key-1 | staging-key-2 | prod-key-3 |
| bocha | dev-key-1 | staging-key-2 | prod-key-3 |
| ... | | | |

**变更规则**：
- 本地开发（`.env.local`）→ 仅使用 dev key
- VPS 部署（`.env.vps.local` / `.env.production`）→ 仅使用 prod key
- **禁止 dev key 上 prod**（实测发现 .env.local 与 .env.vps.local 用了相同 minimax key，应立即分离）

## 跨仓共享密钥（B6）

涉及以下共享密钥（OpenMAIC ↔ Philochora）：

| 密钥名 | 用途 | owner |
|---|---|---|
| `OPENMAIC_SERVICE_API_KEY` | OpenMAIC 服务间认证 | 待指派 |
| `OPENMAIC_SHARED_SECRET` | 章节完成回调签名 | 待指派 |
| `OAUTH_CLIENT_SECRET` | OAuth 客户端凭证 | 待指派 |

**同步机制**：见 [shared-keys-sync.md](./shared-keys-sync.md)（双仓 owner 同步轮换）

## 不变量（Invariants）

1. 一个 provider × environment 组合只能有 1 个 active key
2. `value` 字段永远不进 APIKey 实体（仅在 .env* / KMS 中存在）
3. 跨仓共享密钥视为单一逻辑密钥，统一 owner
4. rotateIntervalDays 默认 90 天，到期必须轮换
5. revoked 状态必须立即从 .env* 移除（不允许残留）

## 工具链

- `scripts/api-key-inventory.mjs`：扫描 .env* 输出 inventory
- `scripts/rotate-keys.mjs`：列出待轮换清单（按 inventory + rotateIntervalDays）
- `scripts/check-secrets.mjs`：防泄漏扫描（pre-commit）
- `lib/logger/redact.ts`：日志脱敏中间件
- `lib/server/key-audit.ts`：调用审计日志
- `lib/alerting/index.ts`：异常告警

## 更新日志

- 2026-08-18：初版（plan 阶段 4 v2）