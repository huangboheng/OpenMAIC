<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **OpenMAIC** (22946 symbols, 56481 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/OpenMAIC/context` | Codebase overview, check index freshness |
| `gitnexus://repo/OpenMAIC/clusters` | All functional areas |
| `gitnexus://repo/OpenMAIC/processes` | All execution flows |
| `gitnexus://repo/OpenMAIC/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

---

## 会话终止语义（硬规则，BR-091-fix）

> 任务完成的定义是「目标可验证条件全部满足 + 关键交付物已落地」。
> 会话终止**不等于**询问下一步。

### 必须遵守

1. 任务（含 plan 执行、代码修改、bug 修复、调研、回答等）完成后，**禁止**主动输出"下一步要做什么"或同义引导句
2. 终止报告必须只包含：交付清单 + 验证证据 + 关键决策点 + 遗留风险（若有），然后**停止**
3. 等待用户主动提供下一项任务时再继续；用户沉默 = 任务已完成，不催不引导
4. goal 存在时，最后一步必须调用 `updateGoal({ status: "complete" })`，避免 IDE 把会话一直留在 Running 状态

### 禁止的"礼貌收尾"模板

- "请告诉下一步要做什么"
- "还需要我做点什么吗"
- "Plan 执行完成 / what's next" 类的中英混合结束语
- "如果还需要……，随时告诉我" 类条件式引导
- 在 plan/snapshot 文档中写入"未来轮次检测点 → 直接询问用户下一步"

### 合规的终止输出范式

- 「**任务完成。** 交付：xxx；验证：xxx；风险：xxx（如有）。」
- 一句话即可，无客套，无引导
- 若必须留 hook（如对将来 agent 的提示），写成"等待用户输入"，而非"询问用户下一步"

### 主控点

本规则在 OpenMAIC 项目内的**主控点**是 `.qoder/rules/session-end.md`（`alwaysApply: true`），由 Qoder IDE 自动加载。本节为人工可读副本，便于不通过 IDE 加载的 agent 也能读到。
