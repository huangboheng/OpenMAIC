/**
 * 将课堂数据中的绝对媒体 URL 重写为 basePath 相对路径
 * （兜底兼容浏览器缓存/本地存储中残留的旧绝对地址，避免跨域被拦截）。
 */
export function normalizeMediaUrls<T>(data: T): T {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH;
  if (!basePath) return data;
  const pattern = /https?:\/\/[^/"]+\/(api\/classroom-media\/)/g;
  const transform = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(pattern, `${basePath}/$1`);
    if (Array.isArray(value)) return value.map(transform);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = transform(v);
      return out;
    }
    return value;
  };
  return transform(data) as T;
}
