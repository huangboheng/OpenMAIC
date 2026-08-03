/**
 * basePath 工具
 *
 * OpenMAIC 既可以独立运行（basePath 为空），也可以被 Philochora 以 `/openmaic`
 * 子路径反向代理嵌入。Next.js 的 `basePath` 只会改写它生成的资源 URL（_next、
 * 服务端渲染时插入的 <img> 等），不会改写客户端代码里硬编码的字符串（如
 * `/avatars/teacher.png`）。在子路径部署下，这些字符串发起的请求会被 Philochora
 * vite 代理改写到 `/openmaic/avatars/...`，但 OpenMAIC 自身的 public 静态资源
 * 在 dev（Turbopack）模式下对不带 basePath 的具体文件路径不会自动重定向——它们
 * 会被当成不存在的应用路由直接 404，导致头像、logo 等裂开。
 *
 * Next.js 16 + Turbopack 还有一个独立于 basePath 的 bug：dev 模式下
 * `public/` 下的几乎所有静态资源都无法被服务（除 `app/favicon.ico` 外），
 * 包括 `public/avatars/*.png`、`public/logos/*.svg`、`public/logo-horizontal.png`
 * 等都返回 404。为此 OpenMAIC 自建了 `app/api/public/[...path]/route.ts` 路由，
 * 直接读 `public/` 返回文件内容。
 *
 * 本模块的 `withBasePath` 给静态资源路径补上 basePath 前缀。**关键**：当
 * basePath 为空（即独立运行场景）时，对内置资源路径（/avatars/、/logos/、
 * /vendor/、/logo-horizontal.png、/openmaic-mark.png）也自动改写到
 * `/api/public/` 路径，以绕过 Turbopack 上述独立 bug。其他用户上传的路径
 * （如 /uploads/*）原样返回，因为它们没有 API 路由 fallback。
 *
 * 拼接 basePath 前自动跳过 data: / blob: / 绝对 URL / 已带 basePath 的输入，
 * 不会破坏用户上传的 data: URL 自定义头像。
 */

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

export const BASE_PATH_PREFIX = BASE_PATH;

// OpenMAIC 内置资源前缀（与 app/api/public/[...path]/route.ts 的白名单保持一致）。
// 命中这些前缀的路径会改写到 /api/public/ 路径，绕过 Next.js 16 Turbopack
// dev 模式 public 资源 404 的 bug；其他路径（如用户上传的 /uploads/*）原样返回。
const BUILTIN_PUBLIC_PREFIXES = ['/avatars/', '/logos/', '/vendor/'] as const;
const BUILTIN_PUBLIC_FILES = new Set(['/logo-horizontal.png', '/openmaic-mark.png']);

/**
 * 把内置 public 资源路径改写到 /api/public/ 路径，绕过 Turbopack bug。
 * 对其他路径原样返回。
 */
function rewriteToApiPublic(path: string): string {
  for (const prefix of BUILTIN_PUBLIC_PREFIXES) {
    if (path.startsWith(prefix)) {
      return `/api/public${path}`
    }
  }
  if (BUILTIN_PUBLIC_FILES.has(path)) {
    return `/api/public${path}`
  }
  return path
}

/**
 * 给静态资源路径补上 basePath 前缀，并自动把内置 public 资源改写到
 * /api/public/ 路由以绕过 Next.js 16 Turbopack dev 模式 public 资源 404 bug。
 *
 * - 非字符串 / 空字符串：返回空字符串
 * - data: / blob: / http(s): / 协议相对 URL：原样返回（用户上传的 data: 头像等）
 * - 已带 basePath 前缀：原样返回
 * - 内置 public 资源（/avatars/、/logos/、/vendor/、/logo-horizontal.png、
 *   /openmaic-mark.png）：改写到 /api/public/<原路径>，并补上 basePath
 * - 其他路径：补上 basePath 前缀
 */
export function withBasePath(path: string | undefined | null): string {
  if (!path) return ''
  if (
    path.startsWith('data:') ||
    path.startsWith('blob:') ||
    path.startsWith('http://') ||
    path.startsWith('https://') ||
    path.startsWith('//')
  ) {
    return path
  }
  // 内置 public 资源改写到 /api/public/，再走标准 basePath 拼接
  const rewritten = rewriteToApiPublic(path)
  if (rewritten === path) {
    // 非内置资源：仅在 basePath 非空时补前缀
    if (!BASE_PATH) return path
    if (path === BASE_PATH || path.startsWith(BASE_PATH + '/')) return path
    return BASE_PATH + (path.startsWith('/') ? path : '/' + path)
  }
  // 改写后的路径是 /api/public/avatars/... 等，basePath 为空时直接返回，
  // basePath 非空时补前缀（如 /openmaic/api/public/avatars/...）
  if (!BASE_PATH) return rewritten
  if (rewritten === BASE_PATH || rewritten.startsWith(BASE_PATH + '/')) return rewritten
  return BASE_PATH + (rewritten.startsWith('/') ? rewritten : '/' + rewritten)
}
