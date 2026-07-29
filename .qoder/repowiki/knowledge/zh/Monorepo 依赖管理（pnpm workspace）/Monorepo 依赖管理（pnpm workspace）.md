---
kind: dependency_management
name: Monorepo 依赖管理（pnpm workspace）
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - pnpm-workspace.yaml
    - packages/@openmaic/dsl/package.json
    - packages/@openmaic/importer/package.json
    - packages/@openmaic/renderer/package.json
    - packages/@openmaic/storage/package.json
---

## 系统概览
OpenMAIC 采用 **pnpm + workspace monorepo** 管理依赖，根 `package.json` 声明应用级依赖与脚本，`packages/` 下拆分为多个独立 npm 包，通过 `workspace:*` 协议实现包间零拷贝引用。

## 关键文件与结构
- `package.json`：根应用依赖、脚本入口、`pnpm.workspaces` 配置、`packageManager` 锁定 pnpm 版本
- `pnpm-workspace.yaml`：定义 workspace 包含 `packages/*` 与 `packages/@openmaic/*`，排除 `packages/docs`
- `packages/@openmaic/dsl`：DSL 契约包（类型 + JSON Schema），被 importer/renderer/storage 共同依赖
- `packages/@openmaic/importer`：PPTX 解析工具，依赖 DSL
- `packages/@openmaic/renderer`：React 渲染组件，声明 peerDependencies（react、motion、echarts、shiki、tailwindcss）
- `packages/@openmaic/storage`：可插拔持久化层，仅依赖 DSL
- `packages/mathml2omml`、`packages/pptxgenjs`：第三方库补丁包，在 postinstall 中构建

## 架构与约定
1. **Workspace 内包** 统一使用 `"workspace:*"` 引用，避免版本分裂，确保类型与运行时一致
2. **外部依赖** 在根 `package.json` 中集中声明，子包不重复声明共享依赖（如 react、typescript）
3. **构建顺序** 通过 `postinstall` 脚本串行构建各子包：mathml2omml → pptxgenjs → @openmaic/dsl → storage → importer → renderer
4. **发布配置** 每个包均设置 `publishConfig.registry: https://registry.npmjs.org` 与 `access: public`，支持独立发布到 npm
5. **peerDependencies** 对框架级依赖（react、tailwindcss、shiki）使用 peer 声明，由宿主应用提供，避免重复打包
6. **Node 版本锁定** `engines.node >= 20.9.0` 保证运行环境一致性
7. **pnpm 优化** 通过 `ignoredBuiltDependencies` 跳过 sharp、unrs-resolver 等原生模块的重复构建

## 开发者规则
- 新增内部包时，在 `pnpm-workspace.yaml` 中注册路径，并在根 `package.json` 中以 `workspace:*` 引用
- 共享依赖（react、typescript、vitest 等）只应在根 `package.json` 声明，子包通过 workspace 协议复用
- 框架级依赖使用 `peerDependencies` + `peerDependenciesMeta.optional` 标记可选依赖
- 所有包必须提供 `prepublishOnly: "pnpm run build"` 确保发布前完成构建
- 原生模块依赖需在根 `pnpm.ignoredBuiltDependencies` 或子包 `pnpm.onlyBuiltDependencies` 中显式声明
- 禁止在子包中直接修改 node_modules，所有依赖变更通过 `pnpm add` 更新根或子包的 package.json