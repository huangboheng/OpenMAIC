# KMS / Vault 集成评估（阶段 7）

> 配套 plan：阶段 7
> 适用范围：OpenMAIC + Philochora 双仓
> 当前状态：**评估文档，**未实施。**仅作为长期演进方向。

## 目标

将 VPS 上明文 `.env.secrets` 替换为运行时动态解密的短期凭证，从根本上消除"密钥落盘"风险。

## 现状盘点（2026-08-18）

### 密钥存储位置

| 环境 | 存储位置 | 权限 | 备份策略 |
|---|---|---|---|
| OpenMAIC 本地 dev | `~/.env.local` | 600 | 无 |
| OpenMAIC VPS prod | `/var/www/openmaic/.env.local` | 600（部署脚本 chmod） | `/root/deploy-backups/`（7 天清理） |
| Philochora 本地 dev | `~/.env` / `~/.env.local` | 600 | 无 |
| Philochora VPS prod | `/var/www/philochora/.env.secrets` | 600 | `/root/deploy-backups/`（7 天清理） |

### 已实施的多层防护（v2 阶段 1-6）

1. **本地防护**：pre-commit + CI + 历史扫描 + tar 隔离 + 文件权限
2. **运行防护**：provider-config.ts 不外泄密钥 + 日志脱敏
3. **监控**：key-audit.log + detect-key-abuse.mjs + alerting
4. **应急**：IR Playbook + rotate-keys.mjs

**剩余风险**：
- 密钥仍以**明文形式**存于 VPS 文件系统
- 一旦 VPS 被入侵（root 权限），所有密钥立即泄露
- 备份目录在 `/root/deploy-backups/`，7 天保留期内仍是明文

## 候选方案对比

### 方案 A：阿里云 KMS（Alibaba Cloud Key Management Service）

**优势**：
- 已在阿里云生态内（OpenMAIC/Philochora VPS 是阿里云 ECS）
- 与 RAM 角色集成，支持临时凭证（STS Token）
- SDK 成熟（Node.js / Java / Python）
- 国内访问稳定，无网络限制

**劣势**：
- 需要 ECS 通过 RAM Role 授权访问 KMS
- 每次解密需调用 KMS API（延迟 ~10-50ms）
- 密钥管理 UI 在阿里云控制台，与 provider 控制台分散
- KMS 密钥本身需要保护（KMS 主密钥由阿里云托管，但需 IAM 授权）

**实施成本**：
- 开发：1-2 周（每个 provider 集成 + 缓存策略）
- 运维：阿里云 KMS 费用（约 0.6 元/万次调用 + 密钥存储费，可忽略）
- 风险：KMS API 故障时密钥不可用，需本地缓存 fallback

### 方案 B：HashiCorp Vault（自托管）

**优势**：
- 开源，灵活的 policy (HCL) 控制
- 支持多种 secret backend（AWS KMS / GCP KMS / 文件 / 数据库）
- 内置动态凭证（如 AWS IAM 临时凭证）
- 完善的 audit log

**劣势**：
- 自托管需要额外 VM（成本 +50-100 元/月）
- HA 配置复杂（至少 3 节点）
- 国内访问 Vault 较慢（vault 主站在墙外）
- 团队需要学习 Vault policy 语法

**实施成本**：
- 开发：2-3 周（Vault server 部署 + 应用集成）
- 运维：自托管 VM 维护 + 备份 + 监控（额外 0.5 人天/月）
- 风险：Vault server 故障 = 整个系统无密钥可用

### 方案 C：环境变量 + 加密备份（轻量替代）

**优势**：
- 无新依赖，立即可实施
- 与现有 .env 兼容
- 备份用 GPG/age 加密

**劣势**：
- 仅加密静态文件，运行时仍是明文（root 可读）
- 不解决"VPS 被入侵 → 密钥泄露"的核心问题
- 仅作为过渡方案

**实施成本**：
- 开发：1-2 天
- 运维：备份密钥管理（独立于 VPS）
- 风险：低，但收益有限

## 推荐路径

| 阶段 | 方案 | 时间 | 触发条件 |
|---|---|---|---|
| **短期（1-2 周）** | 方案 C（加密备份） | 立即 | 已知泄漏已处置后 |
| **中期（1-2 月）** | 方案 A（阿里云 KMS） | 下季度 | KMS 服务稳定性验证后 |
| **长期（3-6 月）** | 方案 A + 临时凭证（STS） | 关键密钥场景 | 团队熟悉 KMS 后 |

### 短期推荐：方案 C 加密备份

**实施步骤**：
1. 备份脚本使用 `age` 或 GPG 加密 .env.secrets
2. 备份密钥存储在 VPS 外部（如另一个独立机器 / 密码管理器）
3. 部署时从加密备份解密到 VPS（解密密钥从密码管理器人工输入）
4. 部署完成后立即清除解密密钥

**验收**：
- 备份文件无法在没有密钥的情况下被读取
- 备份密钥存储位置与 VPS 完全隔离
- 部署流程增加解密步骤（< 30s）

### 中期推荐：方案 A 阿里云 KMS

**实施步骤**：
1. 在阿里云 KMS 创建主密钥（CMK）
2. 在 ECS 上配置 RAM Role，授予 `kms:Decrypt` 权限
3. 把 .env.secrets 中的每个敏感值用 KMS 加密，结果存为 `kms-encrypted:<base64>`
4. 应用启动时调用 `KMS.Decrypt` 解密，加密结果缓存到内存（带 TTL）
5. 缓存过期或重启时重新解密

**关键设计**：
- 单次解密后缓存 1 小时（平衡性能和安全）
- 解密失败时回退到环境变量（兼容旧部署）
- 监控 `kms-decrypt-failed` 告警

**验收**：
- 服务启动后无明文密钥落盘（`/proc/<pid>/environ` 除外，但已受 OS 保护）
- KMS API 故障时服务自动降级
- 解密延迟 < 100ms（P95）

## 多环境密钥分发策略

无论选择哪种方案，密钥分发都应遵循：

| 环境 | KMS 密钥别名 | IAM 授权 | 凭证 TTL |
|---|---|---|---|
| dev | `philochora/dev/{provider}` | dev 开发者 | 24h |
| staging | `philochora/staging/{provider}` | CI / 部署账号 | 12h |
| prod | `philochora/prod/{provider}` | 部署账号 + ECS RAM Role | 1h（短期） |

每个 (env, provider) 组合独立密钥，互不影响。

## 决策门槛（不实施前需评估）

1. **业务影响**：方案 A 需要所有 provider 都通过 KMS 取 key；如果某个 provider 不支持自定义凭证（如 Azure managed identity-only），需要绕过
2. **延迟影响**：KMS 解密延迟 ~10-50ms，对实时 API 是否有影响？
3. **故障恢复**：KMS 服务不可用时，降级路径是什么？直接宕机还是回退到 .env？
4. **成本评估**：阿里云 KMS 调用费用 + ECS RAM Role 配置费用

## 不实施（暂缓）

- **Vault 自托管**：自托管成本高于 KMS，且国内访问慢，不推荐
- **cloud-vault SaaS**（如 Akeyless / HashiCorp Cloud）：与阿里云生态割裂，采购流程长
- **完全无密钥**（如 OpenAI managed identity）：当前 provider 多数不支持

## 相关文档

- [api-key-model.md](./api-key-model.md)
- [incident-response-playbook.md](./incident-response-playbook.md)
- [shared-keys-sync.md](./shared-keys-sync.md)

## 更新日志

- 2026-08-18：初版（plan 阶段 7 v2 评估）