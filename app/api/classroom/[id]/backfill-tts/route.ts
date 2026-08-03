import { type NextRequest } from 'next/server';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import {
  buildRequestOrigin,
  isValidClassroomId,
  readClassroom,
  persistClassroom,
} from '@/lib/server/classroom-storage';
import { backfillMissingTTSForClassroom } from '@/lib/server/classroom-media-generation';
import { createLogger } from '@/lib/logger';

const log = createLogger('BackfillTTS API');

/**
 * POST /api/classroom/[id]/backfill-tts
 *
 * 为已有课堂补齐缺失的预生成音色音频（四种预设音色）。
 * 与 regenerate-tts（全量重生成）不同，只生成磁盘上不存在的
 * (speech action × 音色) 文件，已存在的文件保持不变（节省 API 费用）。
 * 完成后按实际存在的文件修正 classroom JSON 中的 audioId/audioUrl 字段。
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  let classroomId: string | undefined;
  try {
    const { id } = await context.params;
    classroomId = id;

    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    const classroom = await readClassroom(id);
    if (!classroom) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }

    const baseUrl = buildRequestOrigin(request);
    const { scenes, stage } = classroom;

    if (!scenes || scenes.length === 0) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Classroom has no scenes');
    }

    log.info(`Backfilling missing TTS for classroom ${id} (${scenes.length} scenes)`);

    // 只补缺失的音色文件，并按磁盘实况更新 scenes 中的 audioId/audioUrl
    const stats = await backfillMissingTTSForClassroom(scenes, id, baseUrl);

    // 重新持久化 classroom JSON（含更新后的 audioId/audioUrl）
    await persistClassroom({ id, stage, scenes }, baseUrl);

    log.info(`TTS backfill complete for classroom ${id}: ${JSON.stringify(stats)}`);

    return apiSuccess({
      classroomId: id,
      scenesProcessed: scenes.length,
      stats,
      message: 'TTS backfill complete',
    });
  } catch (error) {
    log.error(`TTS backfill failed [id=${classroomId ?? 'unknown'}]:`, error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'TTS backfill failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}
