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
 * `withBasePath` 在拼接 basePath 前自动跳过 data: / blob: / 绝对 URL / 已带
 * basePath 的输入，保证独立运行（空 basePath）和子路径嵌入两种部署都能工作，
 * 也不会破坏用户上传的 data: URL 自定义头像。
 */

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

export const BASE_PATH_PREFIX = BASE_PATH;

/**
 * 给静态资源路径补上 basePath 前缀。非字符串、绝对 URL、内联 data: URL、
 * blob: URL 以及已经带 basePath 的输入原样返回。
 */
export function withBasePath(path: string | undefined | null): string {
  if (!path) return '';
  if (!BASE_PATH) return path;
  if (
    path.startsWith('data:') ||
    path.startsWith('blob:') ||
    path.startsWith('http://') ||
    path.startsWith('https://') ||
    path.startsWith('//')
  ) {
    return path;
  }
  if (path === BASE_PATH || path.startsWith(BASE_PATH + '/')) return path;
  return BASE_PATH + (path.startsWith('/') ? path : '/' + path);
}
