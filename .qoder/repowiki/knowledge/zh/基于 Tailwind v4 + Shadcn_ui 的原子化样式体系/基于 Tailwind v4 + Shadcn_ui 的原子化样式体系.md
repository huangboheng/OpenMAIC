---
kind: frontend_style
name: 基于 Tailwind v4 + Shadcn/ui 的原子化样式体系
category: frontend_style
scope:
    - '**'
source_files:
    - app/globals.css
    - app/layout.tsx
    - lib/hooks/use-theme.tsx
    - lib/utils/cn.ts
    - components/ui/button.tsx
---

## 系统概览
OpenMAIC 前端采用 **Tailwind CSS v4** 作为核心样式引擎，配合 **Shadcn/ui** 组件库与 **class-variance-authority (CVA)** 构建原子化、可组合的 UI 风格体系。主题通过 CSS 变量在 `:root` 和 `.dark` 类中定义，支持亮色/暗色/系统三种模式切换。

## 核心架构
- **样式入口**: `app/globals.css` 是全局样式唯一入口，使用 `@import 'tailwindcss'`（v4 新语法）直接引入 Tailwind，无需传统 `tailwind.config.js`
- **设计令牌**: 所有颜色、圆角、字体等设计令牌通过 CSS 变量定义在 `:root` 和 `.dark` 中，并通过 `@theme inline` 暴露给 Tailwind
- **组件库**: `components/ui/` 下每个文件对应一个 Shadcn/ui 基础组件，全部基于 CVA 管理变体（variant/size）
- **工具函数**: `lib/utils/cn.ts` 提供 `cn()` 函数，组合 `clsx` 和 `tailwind-merge` 处理类名冲突

## 主题系统
- **ThemeProvider**: `lib/hooks/use-theme.tsx` 管理主题状态，支持 light/dark/system 三种模式
- **CSS 变量**: 主色调 `--primary: #722ed1`（亮色）/ `#8b47ea`（暗色），使用 OKLCH 色彩空间保证可访问性
- **字体**: 结合 Geist Sans/Mono 与 Inter Variable Font，通过 CSS 变量注入

## 关键约定
1. **组件样式**: 使用 CVA 定义变体，通过 `data-slot`、`data-variant`、`data-size` 属性标记
2. **类名合并**: 统一通过 `cn()` 函数处理，避免 Tailwind 类名覆盖问题
3. **响应式**: 完全依赖 Tailwind 断点系统，无自定义媒体查询
4. **动画**: 自定义动画集中在 `globals.css` 中，如 shimmer、breathing-bar、ai-thinking-shimmer
5. **编辑器样式**: ProseMirror 编辑器样式通过 `.prosemirror-editor` 类隔离，避免影响播放模式
6. **PBL 工作区**: 通过 `[data-pbl-workspace='true']` 作用域隔离滚动条和卡片样式

## 依赖生态
- Tailwind CSS v4（新 `@import 'tailwindcss'` 语法）
- shadcn/ui（通过 `shadcn/tailwind.css` 引入）
- tw-animate-css（动画增强）
- class-variance-authority（组件变体管理）
- clsx + tailwind-merge（类名合并）
- animate.css（通用动画库）
- katex（数学公式渲染）