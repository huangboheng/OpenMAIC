/**
 * 子路径部署 fetch 拦截器（basePath shim）
 *
 * 当 OpenMAIC 以 basePath（如 /openmaic）被反向代理嵌入主站时，
 * 客户端代码中的根相对请求 fetch('/api/...') 会落到主站的 /api 而非本应用，
 * 导致课堂加载失败（"Loading classroom..."）。
 *
 * 本模块在客户端 bundle 求值期（早于任何组件 useEffect 中的 fetch）安装全局拦截器，
 * 将 '/api/' 开头的请求自动补上 basePath 前缀，使其命中本应用的 API 路由。
 * 独立运行（basePath 为空）时不做任何改写。
 *
 * 注意：仅改写同 origin 的根相对字符串请求；绝对 URL（如媒体直链）与 Request 对象不受影响。
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

declare global {
  interface Window {
    __openmaicFetchPatched?: boolean;
  }
}

if (basePath && typeof window !== 'undefined' && !window.__openmaicFetchPatched) {
  window.__openmaicFetchPatched = true;
  const originalFetch = window.fetch.bind(window);

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/api/')) {
      input = basePath + input;
    }
    return originalFetch(input, init);
  }) as typeof window.fetch;
}

export {};
