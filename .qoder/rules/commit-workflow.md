---
alwaysApply: true
---

# 任务完成后自动提交规则

每次完成功能开发、Bug修复、重构或阶段性验证后，必须主动执行 git commit，无需用户提醒。

> 硬门禁（钩子层强制，无法被遗忘）：
> - `.githooks/pre-push` 会阻断带未提交变更的 push（逃生口 `SKIP_DIRTY=1 git push`）

## 提交前流程（严格按顺序）

1. **检查 worktree 分支**：运行 `git worktree list`，如有未合并的 worktree 分支，先合并其变更到当前分支
2. **检查远程分支**：运行 `git fetch origin`，比较 `origin/main` 与本地 HEAD，如有差异则 `git merge origin/main`
3. **解决冲突**：如有冲突，解决后 `git add` 冲突文件，确认无残留冲突标记
4. **验证**：
   - tsc/build 无报错
   - 无调试残留（console.log、debugger、临时注释）
   - `git status` 确认无遗漏文件
5. **提交**：`git commit -m "type(scope): 描述"`

## 提交规范

- 遵循 Conventional Commits：`type(scope): 简要描述`
- type 限定：feat / fix / docs / refactor / perf / test / chore / security
- scope 填写受影响模块
- 代码+文档混合变更时，type 取代码变更类型，正文注明文档更新
- 单次提交聚焦一个逻辑变更单元
- 禁止使用 WIP、tmp、update、fix bug 等无意义描述

## Critical 变更伴随记录

提交 critical 变更（部署/同步脚本、环境配置、CI/CD、数据库迁移、安全相关等）时，提交信息必须附带伴随记录（提交正文，而非仅标题），使变更在到达提交边界时有可追溯的决策证据：

1. **意图**：为何需要此变更、解决什么问题、不做的后果
2. **验收方式**：如何验证变更生效（命令、指标、预期结果）
3. **临时脚本生命周期**（涉及 `tmp-*` 脚本时）：
   - 为何临时（一次性用途、正式方案尚未定型）
   - 何时清理（任务结束即清理 / 正式方案定型即清理 / 最长保留 7 天，三选一，与 tmp-script-governance.md 一致）
   - 替代方案（转正路径或正式方案的形态）

> 目的：读者无需回溯会话即可理解决策依据与后续清理义务。

## 例外

- 用户明确说"先别提交"时，跳过提交
- 改动未完成且无法通过编译时，使用 `git stash` 保存现场
