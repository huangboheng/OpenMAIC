---
kind: frontend_style
name: 基于 Tailwind v4 + shadcn/ui 的原子化样式系统
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
---

## 样式体系概览
OpenMAIC 采用 **Tailwind CSS v4** 作为核心样式引擎，结合 **shadcn/ui** 组件库与 **class-variance-authority (CVA)** 变体系统，形成一套以原子类为主、设计令牌（CSS 变量）为基色的前端风格方案。所有 UI 组件均通过 `components/ui/` 目录下的 React 组件暴露，业务页面和子模块统一复用这些基础组件，确保视觉一致性。

## 核心架构与约定
- **样式入口**：`app/globals.css` 是全局样式唯一入口，使用 `@import 'tailwindcss'`、`@import 'tw-animate-css'`、`@import 'shadcn/tailwind.css'` 引入依赖，并通过 `@theme inline` 将 CSS 变量映射到 Tailwind 主题命名空间。
- **设计令牌**：在 `:root` 和 `.dark` 中定义完整的 OKLCH 色彩体系（background、foreground、primary、accent、destructive、chart-*、sidebar-* 等），配合 `--radius` 圆角变量，支持明暗主题切换。
- **字体策略**：`app/layout.tsx` 中通过 `next/font/local` 加载 Inter Variable，同时引入 Geist Sans/Mono 作为默认字体，并在 `globals.css` 的 `@theme` 中声明 `--font-sans`、`--font-mono`。
- **动画系统**：通过 `tw-animate-css` 提供 `animate-in`、`fade-in-0`、`zoom-in-95` 等预置动画，项目内还自定义了 `ai-thinking-shimmer`、`shimmer`、`interactive-mode-breathe` 等关键帧。

## 组件样式规范
- **原子类优先**：所有组件样式以 Tailwind 原子类组合为主，禁止在组件内写独立 CSS 文件。
- **变体系统**：通过 `class-variance-authority` 管理组件变体（如 Button 的 `variant`、`size`），使用 `cva()` 定义默认样式与变体映射。
- **条件样式合并**：统一通过 `lib/utils/cn.ts` 中的 `cn()` 函数（clsx + tailwind-merge）合并 className，避免冲突。
- **数据属性标记**：组件通过 `data-slot`、`data-variant`、`data-size` 等属性标记状态，便于样式选择器精准定位。
- **Radix 无障碍**：底层交互组件基于 Radix UI，遵循其语义化 API 与键盘导航约定。

## 特殊场景样式处理
- **编辑器模式隔离**：通过 `body[data-maic-editor='true']` 作用域控制 ProseMirror 编辑器的列表样式、focus outline 等行为，不影响播放模式渲染。
- **PBL v2 工作区**：使用 `[data-pbl-workspace='true']` 限定 PBL 场景的滚动条、卡片、气泡等样式，避免污染全局。
- **第三方库集成**：通过 `@source` 指令显式扫描 `streamdown`、`@openmaic/renderer`、`slide-renderer-demo` 等依赖中的动态类名。
- **滚动条定制**：全局隐藏滚动条或仅 hover 显示，PBL 工作区使用渐变透明滚动条并适配 WebKit 与非 WebKit 浏览器。

## 开发者约定
1. **新增组件样式**：优先使用 Tailwind 原子类，复杂变体用 CVA 管理，禁止创建独立 CSS 文件。
2. **颜色使用**：必须引用设计令牌（如 `bg-primary`、`text-muted-foreground`），禁止硬编码色值。
3. **主题适配**：所有样式需同时考虑 `.dark` 主题下的表现，使用 Tailwind 的 `dark:` 前缀。
4. **动画规范**：优先使用 `tw-animate-css` 预置动画，自定义动画需在 `globals.css` 中集中定义。
5. **响应式策略**：基于 Tailwind 的断点系统（sm/md/lg/xl），避免媒体查询硬编码。
6. **可访问性**：保留 Radix 组件的焦点管理与 ARIA 属性，不覆盖默认的 focus-visible 样式。