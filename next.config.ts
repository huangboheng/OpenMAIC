import type { NextConfig } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';

const nextConfig: NextConfig = {
  // Keep Next dev from creating or rewriting repository agent instructions.
  agentRules: false,
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
  env: {
    INTERACTIVE_ASSET_BASE_URL:
      process.env.INTERACTIVE_ASSET_BASE_URL?.trim() || '/vendor/interactive',
  },
  outputFileTracingIncludes: {
    '/*': [
      'lib/server/agent-runtime/import-pptx-worker.mjs',
      'skills/openmaic/**',
      'skills/agent-runtime/**',
      // Loaded through a runtime-only `import('undici')` (see the LLM
      // dispatcher in lib/ai/providers.ts and the Google proxy transport), so
      // the output tracer never sees it and standalone builds ship without it.
      'node_modules/undici/**',
      // sharp's native libvips libraries are loaded via dlopen and are not
      // statically analyzable, so Next.js standalone tracing omits them. Two
      // sharp versions resolve in the tree (0.34.5 transitive -> libvips
      // 1.2.4, 0.35.4 direct -> libvips 1.3.3); tracing picked the wrong one
      // and the runtime dlopen of sharp 0.35.4 failed with
      // "libvips-cpp.so.8.18.6: No such file or directory" on self-hosted
      // Docker (Alpine/musl) deployments. Force-include every sharp-libvips
      // native lib dir.
      'node_modules/.pnpm/@img+sharp-libvips-*/node_modules/@img/sharp-libvips-*/lib/**',
    ],
  },
  typescript: {
    tsconfigPath: process.env.NODE_ENV === 'production' ? 'tsconfig.build.json' : 'tsconfig.json',
  },
  transpilePackages: ['mathml2omml', 'pptxgenjs', '@openmaic/importer'],
  // These agent packages do a runtime `import(specifier)` with a computed
  // specifier (to lazily load node:fs/os/path without breaking browser/Vite
  // builds). webpack can't statically analyze that and bundling it throws
  // "Cannot find module as expression is too dynamic" at runtime on the server
  // (the "Edit with AI" Pro-mode path), which broke the #619 keep-alive e2e.
  // Mark them server-external so Next loads them natively and the dynamic
  // import resolves as a real Node call.
  serverExternalPackages: [
    '@earendil-works/pi-ai',
    '@earendil-works/pi-agent-core',
    'shiki',
    '@openmaic/generation',
    // Optional peers of @openmaic/storage, reached through deliberately
    // untraced dynamic imports. Externalizing keeps them out of the bundle,
    // and the static anchor in lib/persistence/asset-byte-store.ts gets them
    // traced into the standalone image -- without it, S3 mode and redirect
    // egress cannot resolve their SDK in the shipped deployment.
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
  ],
  experimental: {
    proxyClientMaxBodySize: '200mb',
  },
  async headers() {
    const extraAncestors = process.env.ALLOWED_FRAME_ANCESTORS?.trim();
    const frameAncestors = extraAncestors ? `'self' ${extraAncestors}` : "'self'";

    return [
      {
        source: '/vendor/interactive/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
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
      {
        // Provider logos are drawn wherever services are listed, and each tab
        // switch mounts a fresh set of them. With Next's default `max-age=0`
        // every one is revalidated first and stays blank until the server
        // answers. They are not content-hashed, so cache for a day, not forever.
        source: '/logos/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' },
        ],
      },
    ];
  },
};

// NEXT_PUBLIC_PI_CHAT_ENABLED used to opt out of Pi into the legacy
// director-graph classroom chat. That runtime is gone, so a production build
// that still carries any value which once selected it fails instead of
// silently switching the deployment to Pi. These values never did.
const PI_CHAT_FLAG_VALUES_STILL_ACCEPTED = new Set(['', 'true', '1']);

export default function config(phase: string): NextConfig {
  const piChatFlag = process.env.NEXT_PUBLIC_PI_CHAT_ENABLED;
  if (
    phase === PHASE_PRODUCTION_BUILD &&
    piChatFlag !== undefined &&
    !PI_CHAT_FLAG_VALUES_STILL_ACCEPTED.has(piChatFlag)
  ) {
    throw new Error(
      `NEXT_PUBLIC_PI_CHAT_ENABLED is set to ${JSON.stringify(piChatFlag)}, but the legacy ` +
        'director-graph classroom chat has been removed and this variable can no longer ' +
        'select it. Remove NEXT_PUBLIC_PI_CHAT_ENABLED, then select a model that supports ' +
        'tool calling for Classroom (Settings → Course Model Config, or the `classroom` ' +
        'slot in openmaic.yml and the `llm` slot it inherits from). For Gemini, use the ' +
        'native `google` preset. If the model configuration is managed by an administrator, ' +
        'ask them to make this change.',
    );
  }
  return nextConfig;
}
