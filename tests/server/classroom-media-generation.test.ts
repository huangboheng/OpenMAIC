import { describe, expect, test, vi, beforeEach } from 'vitest';
import nodePath from 'path';
import { replaceMediaPlaceholders } from '@/lib/server/classroom-media-generation';
import type { Scene } from '@/lib/types/stage';

const audioFilePath = (classroomId: string, filename: string) =>
  nodePath.join('/mock-classrooms', classroomId, 'audio', filename);

function slideScene(
  elements: Array<{ id: string; type: string; src?: string; mediaRef?: string }>,
) {
  return {
    id: 'scene_1',
    stageId: 'stage_1',
    type: 'slide',
    title: 'Scene',
    order: 1,
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas_1',
        elements,
      },
    },
  } as unknown as Scene;
}

describe('classroom media placeholder replacement', () => {
  test('preserves direct video src when mediaRef is also present', () => {
    const scene = slideScene([
      {
        id: 'video_1',
        type: 'video',
        src: 'https://example.com/direct.mp4',
        mediaRef: 'gen_vid_real123',
      },
    ]);

    replaceMediaPlaceholders([scene], {
      gen_vid_real123: 'https://cdn.example.com/generated.mp4',
    });

    const content = scene.content as {
      canvas: { elements: Array<{ src?: string }> };
    };
    const video = content.canvas.elements[0];
    expect(video.src).toBe('https://example.com/direct.mp4');
  });

  test('preserves an author-supplied non-URL src when mediaRef is also present', () => {
    const scene = slideScene([
      {
        id: 'video_1',
        type: 'video',
        src: 'lesson-intro.mp4',
        mediaRef: 'gen_vid_real123',
      },
    ]);

    replaceMediaPlaceholders([scene], {
      gen_vid_real123: 'https://cdn.example.com/generated.mp4',
    });

    const content = scene.content as {
      canvas: { elements: Array<{ src?: string }> };
    };
    expect(content.canvas.elements[0].src).toBe('lesson-intro.mp4');
  });

  test('does not treat an image placeholder as the video-manifest overwrite guard', () => {
    const scene = slideScene([
      {
        id: 'video_1',
        type: 'video',
        src: 'gen_img_preview123',
        mediaRef: 'gen_vid_real123',
      },
    ]);

    replaceMediaPlaceholders([scene], {
      gen_vid_real123: 'https://cdn.example.com/generated.mp4',
    });

    const content = scene.content as {
      canvas: { elements: Array<{ src?: string }> };
    };
    expect(content.canvas.elements[0].src).toBe('gen_img_preview123');
  });
});

// ---------------------------------------------------------------------------
// Pre-generated multi-voice TTS: audioId/audioUrl must only reference files
// that actually exist on disk (missing-voice 404 root cause).
// ---------------------------------------------------------------------------

vi.mock('@/lib/server/classroom-storage', () => ({
  CLASSROOMS_DIR: '/mock-classrooms',
}));

// In-memory "filesystem" for the TTS tests.
const writtenFiles = new Set<string>();
const existingFiles = new Set<string>();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (filePath: string) => {
        writtenFiles.add(String(filePath));
      }),
      access: vi.fn(async (filePath: string) => {
        if (!existingFiles.has(String(filePath))) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
      }),
    },
  };
});

const generateTTSMock = vi.fn();
vi.mock('@/lib/audio/tts-providers', () => ({
  generateTTS: (...args: unknown[]) => generateTTSMock(...args),
}));

vi.mock('@/lib/server/provider-config', () => ({
  resolveTTSApiKey: vi.fn(() => 'test-key'),
  resolveTTSBaseUrl: vi.fn(() => 'https://tts.test'),
  getServerImageProviders: vi.fn(() => ({})),
  getServerVideoProviders: vi.fn(() => ({})),
  resolveImageApiKey: vi.fn(() => ''),
  resolveImageBaseUrl: vi.fn(() => undefined),
  resolveVideoApiKey: vi.fn(() => ''),
  resolveVideoBaseUrl: vi.fn(() => undefined),
}));

const ALL_VOICE_FILES = [
  'female-yujie',
  'female-shaonv',
  'male-qn-jingying',
  'Chinese__Mandarin__Gentleman',
];

function speechScene(actionId = 'act1', text = '你好') {
  return {
    id: 'scene_1',
    stageId: 'stage_1',
    type: 'slide',
    title: 'Scene',
    order: 1,
    content: { type: 'slide', canvas: {} },
    actions: [{ id: actionId, type: 'speech', text, speed: 1 }],
  } as unknown as Scene;
}

describe('generateTTSForClassroom voice-aware stamping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writtenFiles.clear();
    existingFiles.clear();
    generateTTSMock.mockResolvedValue({ audio: new Uint8Array([1, 2, 3]), format: 'mp3' });
  });

  test('all voices succeed: default-voice audioId + {voice} template URL', async () => {
    const { generateTTSForClassroom } = await import('@/lib/server/classroom-media-generation');
    const scene = speechScene();

    await generateTTSForClassroom([scene], 'room1', 'http://base.test');

    const action = scene.actions![0] as { audioId?: string; audioUrl?: string };
    expect(action.audioId).toBe('tts_s1_act1_female-yujie');
    expect(action.audioUrl).toBe(
      'http://base.test/api/classroom-media/room1/audio/tts_s1_act1_{voice}.mp3',
    );
    expect(writtenFiles.size).toBe(4);
  });

  test('default voice fails: anchor audioId = first success, URL points at that file', async () => {
    generateTTSMock.mockImplementation(async (config: { voice: string }) => {
      if (config.voice === 'female-yujie') throw new Error('voice failed');
      return { audio: new Uint8Array([1]), format: 'mp3' };
    });
    const { generateTTSForClassroom } = await import('@/lib/server/classroom-media-generation');
    const scene = speechScene();

    await generateTTSForClassroom([scene], 'room1', 'http://base.test');

    const action = scene.actions![0] as { audioId?: string; audioUrl?: string };
    expect(action.audioId).toBe('tts_s1_act1_female-shaonv');
    // No {voice} template — it would resolve to the missing default voice.
    expect(action.audioUrl).toBe(
      'http://base.test/api/classroom-media/room1/audio/tts_s1_act1_female-shaonv.mp3',
    );
  });

  test('all voices fail: action stays unvoiced (no audioId/audioUrl)', async () => {
    generateTTSMock.mockRejectedValue(new Error('provider down'));
    const { generateTTSForClassroom } = await import('@/lib/server/classroom-media-generation');
    const scene = speechScene();

    await generateTTSForClassroom([scene], 'room1', 'http://base.test');

    const action = scene.actions![0] as { audioId?: string; audioUrl?: string };
    expect(action.audioId).toBeUndefined();
    expect(action.audioUrl).toBeUndefined();
    expect(writtenFiles.size).toBe(0);
  });
});

describe('backfillMissingTTSForClassroom', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writtenFiles.clear();
    existingFiles.clear();
    generateTTSMock.mockResolvedValue({ audio: new Uint8Array([1, 2, 3]), format: 'mp3' });
  });

  test('only generates missing voice files, keeps existing ones untouched', async () => {
    // Two voices already on disk (default voice + one more).
    existingFiles.add(audioFilePath('room1', 'tts_s1_act1_female-yujie.mp3'));
    existingFiles.add(audioFilePath('room1', 'tts_s1_act1_male-qn-jingying.mp3'));

    const { backfillMissingTTSForClassroom } = await import(
      '@/lib/server/classroom-media-generation'
    );
    const scene = speechScene();

    const stats = await backfillMissingTTSForClassroom([scene], 'room1', 'http://base.test');

    expect(stats).toEqual({ total: 1, missing: 2, generated: 2, failed: 0 });
    // Only the two missing files were written.
    expect(writtenFiles).toEqual(
      new Set([
        audioFilePath('room1', 'tts_s1_act1_female-shaonv.mp3'),
        audioFilePath('room1', 'tts_s1_act1_Chinese__Mandarin__Gentleman.mp3'),
      ]),
    );
    // Default voice exists → template URL restored.
    const action = scene.actions![0] as { audioId?: string; audioUrl?: string };
    expect(action.audioId).toBe('tts_s1_act1_female-yujie');
    expect(action.audioUrl).toBe(
      'http://base.test/api/classroom-media/room1/audio/tts_s1_act1_{voice}.mp3',
    );
  });

  test('nothing missing: no TTS calls, stats all zero except total', async () => {
    for (const v of ALL_VOICE_FILES) {
      existingFiles.add(audioFilePath('room1', `tts_s1_act1_${v}.mp3`));
    }

    const { backfillMissingTTSForClassroom } = await import(
      '@/lib/server/classroom-media-generation'
    );
    const scene = speechScene();

    const stats = await backfillMissingTTSForClassroom([scene], 'room1', 'http://base.test');

    expect(stats).toEqual({ total: 1, missing: 0, generated: 0, failed: 0 });
    expect(generateTTSMock).not.toHaveBeenCalled();
    expect(writtenFiles.size).toBe(0);
  });

  test('backfill generation failure is counted and does not throw', async () => {
    generateTTSMock.mockRejectedValue(new Error('rate limited'));

    const { backfillMissingTTSForClassroom } = await import(
      '@/lib/server/classroom-media-generation'
    );
    const scene = speechScene();

    const stats = await backfillMissingTTSForClassroom([scene], 'room1', 'http://base.test');

    expect(stats).toEqual({ total: 1, missing: 4, generated: 0, failed: 4 });
    const action = scene.actions![0] as { audioId?: string; audioUrl?: string };
    expect(action.audioId).toBeUndefined();
    expect(action.audioUrl).toBeUndefined();
  });
});
