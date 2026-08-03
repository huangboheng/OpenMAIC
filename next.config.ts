import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 子路径部署支持：被 Philochora 以 /openmaic 前缀反向代理时设置 NEXT_PUBLIC_BASE_PATH=/openmaic，
  // 独立运行（直接访问 OpenMAIC 端口）时留空即可。
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',
  // Next.js 16 + Turbopack dev 模式下，对带 basePath 的 public/*.png 请求会
  // 误走 next/image 优化路径（返回 "The requested resource isn't a valid image
  // received null" 并 404）。SVG 等非图片扩展名不受影响。开发环境关闭图片
  // 优化，让 Next.js 直接服务 public/ 原文件。生产环境保留优化能力。
  images: {
    unoptimized: process.env.NODE_ENV !== 'production',
  },
  output: process.env.VERCEL ? undefined : 'standalone',
  transpilePackages: ['mathml2omml', 'pptxgenjs', '@openmaic/importer'],
  serverExternalPackages: ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', 'shiki'],
  experimental: {
    proxyClientMaxBodySize: '200mb',
  },
  async headers() {
    const extraAncestors = process.env.ALLOWED_FRAME_ANCESTORS?.trim();
    const frameAncestors = extraAncestors ? `'self' ${extraAncestors}` : "'self'";

    return [
      {
        source: '/(.*)',
        headers: [
          ...(!extraAncestors ? [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }] : []),
          {
            key: 'Content-Security-Policy',
            value: `frame-ancestors ${frameAncestors}`,
          },
          // SEC-04: Additional security headers
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          ...(process.env.NODE_ENV === 'production'
            ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]
            : []),
        ],
      },
    ];
  },
};

export default nextConfig;
