import { type NextRequest } from 'next/server';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import {
  buildRequestOrigin,
  isValidClassroomId,
  readClassroom,
  persistClassroom,
} from '@/lib/server/classroom-storage';
import { generateTTSForClassroom } from '@/lib/server/classroom-media-generation';
import { createLogger } from '@/lib/logger';

const log = createLogger('RegenerateTTS API');

/**
 * POST /api/classroom/[id]/regenerate-tts
 *
 * 为已有课堂重新生成 TTS 音频（使用当前音色策略）。
 * 会覆盖 data/classrooms/<id>/audio/ 下的所有音频文件，
 * 并更新 classroom JSON 中的 audioId/audioUrl 字段。
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

    log.info(`Regenerating TTS for classroom ${id} (${scenes.length} scenes)`);

    // 重新生成 TTS（会写入新音频文件并更新 scenes 中的 audioId/audioUrl）
    await generateTTSForClassroom(scenes, id, baseUrl);

    // 重新持久化 classroom JSON（含更新后的 audioId/audioUrl）
    await persistClassroom({ id, stage, scenes }, baseUrl);

    log.info(`TTS regeneration complete for classroom ${id}`);

    return apiSuccess({
      classroomId: id,
      scenesProcessed: scenes.length,
      message: 'TTS regeneration complete',
    });
  } catch (error) {
    log.error(`TTS regeneration failed [id=${classroomId ?? 'unknown'}]:`, error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'TTS regeneration failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}
