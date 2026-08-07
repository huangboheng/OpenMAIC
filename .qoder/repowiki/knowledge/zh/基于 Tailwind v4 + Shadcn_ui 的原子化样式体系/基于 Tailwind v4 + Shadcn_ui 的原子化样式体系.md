---
kind: frontend_style
name: 基于 Tailwind v4 + shadcn/ui 的原子化样式体系
category: frontend_style
scope:
    - '**'
source_files:
    - app/globals.css
    - app/layout.tsx
    - components/ui/button.tsx
    - components/ui/input.tsx
    - components/ui/card.tsx
    - components/ui/dialog.tsx
    - components/ui/sonner.tsx
    - lib/utils/cn.ts
    - package.json
---

本仓库采用 **Tailwind CSS v4** 作为核心样式引擎，配合 **shadcn/ui** 组件库与 **class-variance-authority (CVA)** 构建统一的原子化样式系统。整体风格以 CSS 变量驱动的 OKLCH 色彩空间为基础，支持明暗主题切换，并通过 `@theme` 声明集中管理设计令牌（颜色、圆角、字体等）。

### 1. 样式系统与工具链
- **Tailwind v4**：通过 `app/globals.css` 中的 `@import 'tailwindcss'` 引入，使用 `@source` 显式声明扫描路径（包括第三方包如 `streamdown`、`@openmaic/renderer`、`slide-renderer-demo`），确保动态生成的类名能被正确拾取。
- **shadcn/ui**：通过 `@import 'shadcn/tailwind.css'` 引入其默认样式与主题映射，所有 UI 组件均位于 `components/ui/` 下，基于 Radix UI primitives 封装。
- **动画增强**：引入 `tw-animate-css` 提供预置动画类（如 `animate-in`、`fade-in-0`、`zoom-in-95`），同时自定义关键帧（如 `wave`、`shimmer`、`ai-thinking-shimmer`、`interactive-mode-breathe`）用于加载态与交互反馈。
- **字体系统**：根布局中通过 `next/font/local` 注入 Inter 变量字体，并搭配 Geist Sans/Mono；在 `@theme` 中声明 `--font-sans`、`--font-mono`；同时引入 `@fontsource-variable/*` 系列多语言字体（中文、日文、数学公式等）。

### 2. 设计令牌与主题架构
- **CSS 变量驱动**：在 `:root` 与 `.dark` 中定义完整的 OKLCH 色彩语义（primary、secondary、destructive、chart-*、sidebar-* 等），所有组件通过 CSS 变量引用，实现一键换肤；通过 `@theme inline` 将 CSS 变量映射到 Tailwind 主题命名空间。
- **半径系统**：通过 `--radius` 派生出 `radius-sm/md/lg/xl/2xl/3xl/4xl` 七级圆角，统一卡片、按钮、输入框的圆角规范。
- **深色模式**：使用 `@custom-variant dark (&:is(.dark *))` 声明 dark 变体，配合 `next-themes` 在运行时切换。

### 3. 组件样式约定
- **CVA 变体系统**：所有可复用组件（如 `Button`）通过 `class-variance-authority` 声明 `variant`（default/outline/secondary/ghost/destructive/link）与 `size`（xs/sm/default/lg/icon/*）两类变体，避免硬编码样式。
- **类名合并策略**：统一通过 `lib/utils/cn.ts` 中的 `cn()` 函数合并类名，底层组合 `clsx` 与 `tailwind-merge`，确保冲突类名按优先级覆盖。
- **数据属性标记**：组件通过 `data-slot`、`data-variant`、`data-size` 等属性标记状态，便于样式选择器精准定位。
- **Radix 兼容处理**：针对 Radix Modal 的 `react-remove-scroll` 行为，在 `body[data-scroll-locked]` 上重置右侧内边距，避免与 `scrollbar-gutter: stable` 产生布局偏移。

### 4. 编辑器与渲染器专用样式
- **ProseMirror 编辑器**：`.prosemirror-editor` 类专门用于编辑模式，禁用默认 focus outline 以避免与自定义光标冲突；列表样式通过 `!important` 覆盖 Tailwind preflight 重置；通过 `body[data-maic-editor='true']` 作用域控制编辑行为，不影响播放模式渲染。
- **PBL v2 工作区**：通过 `[data-pbl-workspace='true']` 作用域限定滚动条、卡片、气泡等样式，避免污染全局；PBL 工作区使用渐变透明滚动条并适配 WebKit 与非 WebKit 浏览器。
- **第三方集成**：为 `react-colorful`、`katex`、`animate.css` 等外部库提供定制覆盖，保持视觉一致性；全局隐藏滚动条或仅 hover 显示。

### 5. 响应式与可访问性
- **移动端优先**：未使用传统媒体查询，依赖 Tailwind 的响应式前缀（如 `sm:`、`md:`）进行断点控制。
- **无障碍**：遵循 Radix UI 的键盘导航与 ARIA 语义；通过 `prefers-reduced-motion` 媒体查询禁用非必要动画。
- **国际化**：结合 `i18next` 与 `react-i18next`，文本内容本地化，但样式层面无语言差异。

### 6. 约束与规范
- 禁止直接编写原始 CSS 类名，应优先使用 Tailwind 原子类或 shadcn 组件；禁止创建独立 CSS 文件。
- 新增颜色必须通过 CSS 变量定义，禁止硬编码色值。
- 组件样式必须通过 CVA 变体管理，不得在 JSX 中内联 style 属性。
- 编辑器相关样式需以 `.prosemirror-editor` 或 `body[data-maic-editor='true']` 作用域隔离，避免影响播放模式。
- 所有样式需同时考虑 `.dark` 主题表现，使用 `dark:` 前缀；自定义动画需在 `globals.css` 中集中定义。
- 保留 Radix 组件的焦点管理与 ARIA 属性，不覆盖默认的 focus-visible 样式。
