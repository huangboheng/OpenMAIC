# API Key 泄漏应急响应 Playbook（Incident Response Playbook）

> 适用项目：OpenMAIC + Philochora（双仓统一）
> 配套工具：`scripts/check-secrets.mjs`（pre-commit）+ `scripts/check-secrets-history.mjs`（历史回扫）+ `scripts/check-secrets.mjs --scan-file`（CI）
> 治理规则：`.qoder/rules/secrets-scan.md`

## 触发条件

以下任一情况发生时启动本 Playbook：
1. **pre-commit 钩子命中**：本地提交时 `check-secrets.mjs` 检测到真实密钥
2. **CI 扫描命中**：PR 阶段 GitHub Actions 阻断
3. **历史回扫发现**：定时任务或主动扫描发现 git 历史中的密钥
4. **provider 告警**：DeepSeek / MiniMax / Bocha 等通过账单异常告警
5. **第三方披露**：安全研究员、白帽平台通报

## 四阶段响应流程

### 阶段 1：立即响应（T+0 ~ 30 min）

目标：**阻断继续泄漏 + 隔离影响面**

#### 1.1 识别泄漏范围（≤ 5 min）

```bash
# 在受影响仓库根目录
node scripts/check-secrets-history.mjs --since <first_commit> --json > /tmp/leak-audit.json
```

输出含 `commit / author / date / path / line / match`，每条密钥都有唯一指纹。

#### 1.2 吊销密钥（≤ 10 min）

按泄漏的 provider 分类，到对应控制台操作：

| Provider | 控制台 | 操作 |
|---|---|---|
| DeepSeek | https://platform.deepseek.com/api_keys | 删除对应 API Key |
| MiniMax | https://api.minimaxi.com/user-center/basic-information/interface-key | 删除对应 Group |
| Bocha | https://bocha-ai.dashboard.bochaai.com/ | 重置 API Key |
| DashScope（阿里云百炼） | https://bailian.console.aliyun.com/ | 删除对应 API-KEY |
| 阿里云 AK | https://ram.console.aliyun.com/manage/ak | 禁用对应 AccessKey |
| OpenAI | https://platform.openai.com/api-keys | Revoke |
| Anthropic | https://console.anthropic.com/settings/keys | Revoke |

> ⚠️ 如果控制台操作受限（如权限/认证失败），立即在 `.env.secrets` 中删除该变量并重启服务，让现有部署的服务拒绝调用。

#### 1.3 临时禁用 provider（≤ 10 min）

在受影响服务的配置中临时禁用该 provider（针对 OpenMAIC）：

```bash
# OpenMAIC：在 .env.local / .env.vps.local 中给 provider 加 _ENABLED=false
DEEPSEEK_ENABLED=false
TTS_MINIMAX_ENABLED=false
```

或更彻底：在 `server-providers.yml` 中把对应 provider 注释掉。

部署更新：
```bash
# OpenMAIC：触发增量部署
node deploy/pack-deploy.mjs --skip-build --keep-packages

# Philochora：触发完整部署
bash deploy/full-deploy-v2.sh  # 需 DEPLOY_APPROVED=1
```

#### 1.4 通知相关方（≤ 30 min）

- **owner**（按 key-owners-roster.md）
- **项目负责人**
- **如有数据风险**：准备用户公告草稿（暂不发布，等阶段 3 决策）

### 阶段 2：评估范围（T+30 min ~ 2 h）

目标：**量化影响 + 准备修复方案**

#### 2.1 拉取 provider 账单

对每个被吊销的 provider：
- 登录控制台 → Billing → 拉取最近 90 天的调用记录
- 识别是否有**异常调用模式**：
  - 调用量突然激增
  - 异常 IP / 地区
  - 异常 endpoint / model
- 导出 CSV 留证

#### 2.2 评估泄漏时间窗

```bash
# 找到首次泄漏的 commit
git log --all --oneline --diff-filter=A -- scripts/run-translation.mjs
# 或
git log -p --all -S '<key fragment>' --source
```

确认密钥首次进入 git 历史的 commit + 日期 = 泄漏起始时间。

#### 2.3 评估风险等级

| 等级 | 条件 | 行动 |
|---|---|---|
| **P0 紧急** | key 有 admin / write 权限；公开仓库；泄漏 > 7 天 | 立即通知用户 + 全量审计日志 |
| **P1 高** | key 有 read 权限 + 写权限子集；私有仓库；泄漏 1-7 天 | 通知 owner + 监控异常 |
| **P2 中** | key 仅 read；私有仓库；泄漏 < 1 天 | 仅内部修复 |

#### 2.4 评估是否影响用户

- 是否调用过写操作（DB 写入、文件上传、用户数据修改）？
- 是否触达 PII（个人身份信息）？
- 是否需要主动通知用户？（按 GDPR / CCPA 法规）

### 阶段 3：恢复（T+2 h ~ 24 h）

目标：**新密钥部署 + 验证恢复**

#### 3.1 生成新密钥

到 provider 控制台生成新 key，**使用不同前缀或后缀便于识别**（如加 `prod-2026-08-` 前缀）。

#### 3.2 部署到所有环境

```bash
# 本地开发
# 编辑 .env.local（OpenMAIC）或 .env / .env.local（Philochora）

# VPS 生产
# 编辑 /var/www/openmaic/.env.local 和 /var/www/philochora/.env.secrets

# CI（如果有）
# 更新 GitHub Actions secrets
```

#### 3.3 触发部署

```bash
# OpenMAIC
node deploy/pack-deploy.mjs --keep-packages

# Philochora
bash deploy/full-deploy-v2.sh  # 需 DEPLOY_APPROVED=1
```

部署后**取消临时禁用**（把 `_ENABLED=false` 改回 `true` 或移除）。

#### 3.4 验证

- [ ] 服务正常启动
- [ ] 调用 provider 返回成功（用 `curl` 或 health check）
- [ ] 审计日志（`logs/key-audit.log`，阶段 5 计划）出现新 key 的 fingerprint
- [ ] 旧 key 调用立即返回 401（说明已吊销）

### 阶段 4：清理 + 复盘（T+24 h ~ 1 周）

目标：**防止再泄漏 + 完善检测规则**

#### 4.1 清理 git 历史

**本地仓库**：
```bash
# 安装 git-filter-repo
pip install git-filter-repo

# 删除含密钥的行（按文件 + 行号）
git filter-repo --invert-paths --path scripts/run-translation.mjs --force  # 整文件删除（最保守）
# 或更精确：--blob-callback

# 验证历史
node scripts/check-secrets-history.mjs --since HEAD~100 --max-commits 100
```

**远程仓库**（与协作者充分沟通后）：
```bash
git push --force-with-lease
```

> ⚠️ force-push 会重写远程历史，所有协作者必须重新 clone 或 `git rebase`。

#### 4.2 写 incident review

在 `.clay/CHANGES/BR-XXX-incident-key-leak/` 下创建：
- `proposal.md`：事件概要 + 影响范围
- `design.md`：根因分析 + 修复方案
- `tasks.md`：分阶段处置（已完成 / 进行中 / 待办）
- `incident-review.md`：经验教训 + 检测规则更新

#### 4.3 更新检测规则

根据本次泄漏的特征，更新 `lib/secrets-scanner.mjs`：
- 新增 pattern ID
- 扩展 allowlist（如允许特定测试 fixture）
- 提高误报/漏报权衡

提交一个 PR 单独处理规则更新。

#### 4.4 通知用户（如适用）

如评估确认有数据风险，按以下模板通知：

```
【安全通知】<YYYY-MM-DD> API Key 泄漏事件

事件概要：
- 时间：<YYYY-MM-DD HH:MM>
- 影响范围：<provider + 调用类型>
- 已采取行动：<吊销 + 部署新 key>
- 用户数据影响：<无 / 部分 / 全量>
- 后续建议：<建议用户修改密码 / 启用 2FA>

详细技术分析：见 <incident-review 链接>
```

## 应急联系清单

| 角色 | 负责人 | 联系方式 |
|---|---|---|
| 项目 owner | （按 key-owners-roster.md） | — |
| 安全负责人 | （按 key-owners-roster.md） | — |
| VPS 运维 | （按 deploy/scripts） | — |
| Provider 紧急支持 | 见各 provider 控制台 | — |

## 工具清单

| 用途 | 工具 | 路径 |
|---|---|---|
| 本地扫描 | `check-secrets.mjs` | `scripts/check-secrets.mjs` |
| 历史回扫 | `check-secrets-history.mjs` | `scripts/check-secrets-history.mjs` |
| 历史清理 | `git-filter-repo` | `pip install git-filter-repo` |
| OpenMAIC 部署 | `pack-deploy.mjs` | `deploy/pack-deploy.mjs` |
| Philochora 部署 | `full-deploy-v2.sh` | `deploy/full-deploy-v2.sh` |

## 演练

建议每季度做一次桌面演练：
1. 选取一个测试 provider key 模拟泄漏
2. 跑阶段 1 流程（吊销 + 禁用），验证 SLA < 30 min
3. 跑阶段 3 流程（部署新 key），验证服务恢复 < 2 h
4. 跑阶段 4 流程（清理 + 复盘），验证历史扫描无残留

## 相关文档

- [secrets-scan.md](../../.qoder/rules/secrets-scan.md) — 强制规则
- [secrets-history-scan.md](./secrets-history-scan.md) — 历史扫描工具说明
- [api-key-model.md](./api-key-model.md) — APIKey 领域模型（阶段 4）
- [shared-keys-sync.md](./shared-keys-sync.md) — 跨仓共享密钥同步（阶段 4）

## 更新日志

- 2026-08-18：初版，与 v2 加固方案（grilling 优化版）阶段 2 同步落地
