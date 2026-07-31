import { createLogger } from '@/lib/logger';
import { generateClassroom, type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import {
  markClassroomGenerationJobFailed,
  markClassroomGenerationJobRunning,
  markClassroomGenerationJobSucceeded,
  updateClassroomGenerationJobProgress,
} from '@/lib/server/classroom-job-store';

const log = createLogger('ClassroomJob');
const runningJobs = new Map<string, Promise<void>>();

/** 回调 Philochora 通知课堂生成完成 */
async function notifyPhilochora(
  input: GenerateClassroomInput,
  classroomId: string,
  scenesCount?: number,
  totalDuration?: number,
): Promise<void> {
  const { callbackUrl, courseSlug, chapterMapping, serviceApiKey } = input;
  if (!callbackUrl || !courseSlug) return;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (serviceApiKey) {
      headers['x-openmaic-api-key'] = serviceApiKey;
    }

    const res = await fetch(callbackUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        courseSlug,
        classroomId,
        chapters: chapterMapping,
        scenesCount,
        totalDuration,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      log.warn(
        `[ClassroomJob] Philochora callback returned ${res.status}: ${errBody.slice(0, 200)}`,
      );
    } else {
      log.info(`[ClassroomJob] Philochora callback succeeded for course "${courseSlug}"`);
    }
  } catch (err) {
    log.warn(
      `[ClassroomJob] Philochora callback failed for course "${courseSlug}":`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function runClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
  baseUrl: string,
): Promise<void> {
  const existing = runningJobs.get(jobId);
  if (existing) {
    return existing;
  }

  const jobPromise = (async () => {
    try {
      await markClassroomGenerationJobRunning(jobId);

      const result = await generateClassroom(input, {
        baseUrl,
        onProgress: async (progress) => {
          await updateClassroomGenerationJobProgress(jobId, progress);
        },
      });

      await markClassroomGenerationJobSucceeded(jobId, result);

      // 通知 Philochora 课堂生成完成
      if (input.callbackUrl && input.courseSlug) {
        await notifyPhilochora(input, result.id, result.scenesCount, result.stage.totalDuration);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Classroom generation job ${jobId} failed:`, error);
      try {
        await markClassroomGenerationJobFailed(jobId, message);
      } catch (markFailedError) {
        log.error(`Failed to persist failed status for job ${jobId}:`, markFailedError);
      }
    } finally {
      runningJobs.delete(jobId);
    }
  })();

  runningJobs.set(jobId, jobPromise);
  return jobPromise;
}
