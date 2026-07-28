---
kind: dependency_management
name: 基于 pnpm Workspace 的多包依赖管理
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - pnpm-workspace.yaml
    - Dockerfile
    - packages/@openmaic/dsl/package.json
    - packages/@openmaic/renderer/package.json
---

## 系统/工具
- **包管理器**: pnpm 10.28.0（通过 `packageManager` 字段锁定版本，配合 Corepack 启用）
- **工作区**: pnpm workspace 多包结构，根 `pnpm-workspace.yaml` 声明 `packages/*` 与 `packages/@openmaic/*` 两个目录为子包，排除 `packages/docs`
- **锁文件**: 使用 `pnpm-lock.yaml` 作为统一依赖锁定文件，Docker 构建中通过 `--frozen-lockfile` 保证可重复安装
- **Node 版本**: 要求 Node >= 20.9.0（`engines` 字段），Docker 基础镜像使用 `node:22-alpine`

## 关键文件与包
- **根 `package.json`**: 定义应用依赖、脚本（`postinstall` 自动构建所有子包）、`pnpm` 配置（忽略 native 构建的 `sharp`、`unrs-resolver`）
- **`pnpm-workspace.yaml`**: 声明工作区成员，排除 docs 子应用
- **`Dockerfile`**: 多阶段构建，先 `pnpm install --frozen-lockfile` 再 `pnpm build`，运行时仅包含 `.next/standalone` 产物
- **子包**:
  - `@openmaic/dsl`: DSL 类型与 JSON Schema 契约包，无外部依赖
  - `@openmaic/renderer`: React 渲染组件，通过 `peerDependencies` 声明 react、motion、tailwindcss 等宿主依赖
  - `@openmaic/importer`、`@openmaic/storage`: 通过 `workspace:*` 依赖 dsl
  - `mathml2omml`、`pptxgenjs`: 独立 npm 包，通过 `workspace:*` 引用

## 架构与约定
- **Monorepo 设计**: 应用层依赖通过 `workspace:*` 指向本地子包，避免发布到 npm registry，实现零拷贝引用
- **依赖分层**: 
  - 核心契约包（dsl）无依赖，被 renderer/importer/storage 共同依赖
  - 业务包（renderer/importer/storage）通过 peerDependencies 声明可选依赖（echarts、shiki）
  - 第三方库集中在根 `package.json` 的 dependencies/devDependencies 中统一管理
- **构建链**: `postinstall` 脚本按顺序构建 mathml2omml → pptxgenjs → @openmaic/dsl → storage → importer → renderer，最后执行 `scripts/sync-maic-importer.mjs` 同步导入器
- **CI/CD**: GitHub Actions 中使用 `cache-dependency-path` 缓存 `pnpm-lock.yaml`，确保依赖安装加速

## 开发者规则
1. 新增依赖必须添加到根 `package.json`，不要在各子包单独声明（除非是子包私有依赖）
2. 子包之间通过 `workspace:*` 引用，禁止使用版本号或 file: 协议
3. 修改 `pnpm-lock.yaml` 后需提交，Docker 构建会校验 `--frozen-lockfile`
4. 添加 native 依赖时需检查 `pnpm.ignoredBuiltDependencies` 和 Dockerfile 中的系统依赖是否齐全
5. 子包的 `peerDependencies` 应与根依赖版本兼容，避免冲突