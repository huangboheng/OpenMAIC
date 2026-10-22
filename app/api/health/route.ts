import { apiSuccess } from '@/lib/server/api-response';
import { resolveServerGenerationCapabilities } from '@/lib/server/generation-capabilities';
import { getParallelSceneConcurrency, isServerLLMConfigured } from '@/lib/server/provider-config';
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
    // Deployment gate (ADR-0001): false means managed-mode clients can never
    // start a chat/discussion — the deploy health check treats it as failure.
    llmConfigured: isServerLLMConfigured(),
    accessCodeConfigured: Boolean(process.env.ACCESS_CODE),
    capabilities: await resolveServerGenerationCapabilities(),
    // How many scenes the browser may generate at once (PARALLEL_SCENE_CONCURRENCY).
    generation: { parallelSceneConcurrency: getParallelSceneConcurrency() },
  });
}
