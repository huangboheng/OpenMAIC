import { apiSuccess } from '@/lib/server/api-response';
import {
  getServerWebSearchProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerTTSProviders,
} from '@/lib/server/provider-config';
import { readFileSync } from 'fs';
import { join } from 'path';

// 优先读取 VERSION 文件，回退到 npm_package_version
function getVersion(): string {
  try {
    const versionFile = join(process.cwd(), 'VERSION');
    return readFileSync(versionFile, 'utf8').trim();
  } catch {
    return process.env.npm_package_version || '0.1.0';
  }
}

const version = getVersion();

export async function GET() {
  return apiSuccess({
    status: 'ok',
    version,
    capabilities: {
      webSearch: Object.keys(getServerWebSearchProviders()).length > 0,
      imageGeneration: Object.keys(getServerImageProviders()).length > 0,
      videoGeneration: Object.keys(getServerVideoProviders()).length > 0,
      tts: Object.values(getServerTTSProviders()).some((info) => !info.disabled),
    },
  });
}
