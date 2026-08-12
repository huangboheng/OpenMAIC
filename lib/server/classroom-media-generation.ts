/**
 * Server-side media and TTS generation for classrooms.
 *
 * Generates image/video files and TTS audio for a classroom,
 * writes them to disk, and returns serving URL mappings.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';
import { generateImage } from '@/lib/media/image-providers';
import { generateVideo, normalizeVideoOptions } from '@/lib/media/video-providers';
import { generateTTS } from '@/lib/audio/tts-providers';
import {
  TTS_PROVIDERS,
  PREGENERATED_VOICES,
  DEFAULT_PREGENERATED_VOICE,
  voiceIdToFileName,
} from '@/lib/audio/constants';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import {
  getServerImageProviders,
  getServerVideoProviders,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveVideoApiKey,
  resolveVideoBaseUrl,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
} from '@/lib/server/provider-config';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';
import type { ImageProviderId } from '@/lib/media/types';
import type { VideoProviderId } from '@/lib/media/types';
import type { TTSProviderId } from '@/lib/audio/types';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { isGeneratedMediaPlaceholder } from '@/lib/media/media-ref';

const log = createLogger('ClassroomMedia');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

const DOWNLOAD_TIMEOUT_MS = 120_000; // 2 minutes
const DOWNLOAD_MAX_SIZE = 100 * 1024 * 1024; // 100 MB

async function downloadToBuffer(url: string): Promise<Buffer> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  const contentLength = Number(resp.headers.get('content-length') || 0);
  if (contentLength > DOWNLOAD_MAX_SIZE) {
    throw new Error(`File too large: ${contentLength} bytes (max ${DOWNLOAD_MAX_SIZE})`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

function mediaServingUrl(baseUrl: string, classroomId: string, subPath: string): string {
  return `${baseUrl}/api/classroom-media/${classroomId}/${subPath}`;
}

// ---------------------------------------------------------------------------
// Image / Video generation
// ---------------------------------------------------------------------------

export async function generateMediaForClassroom(
  outlines: SceneOutline[],
  classroomId: string,
  baseUrl: string,
): Promise<Record<string, string>> {
  const mediaDir = path.join(CLASSROOMS_DIR, classroomId, 'media');
  await ensureDir(mediaDir);

  // Collect all media generation requests from outlines
  const requests = outlines.flatMap((o) => o.mediaGenerations ?? []);
  if (requests.length === 0) return {};

  // Resolve providers
  const imageProviderIds = Object.keys(getServerImageProviders());
  const videoProviderIds = Object.keys(getServerVideoProviders());

  const mediaMap: Record<string, string> = {};

  // Separate image and video requests, generate each type sequentially
  // but run the two types in parallel (providers often have limited concurrency).
  const imageRequests = requests.filter((r) => r.type === 'image' && imageProviderIds.length > 0);
  const videoRequests = requests.filter((r) => r.type === 'video' && videoProviderIds.length > 0);

  const generateImages = async () => {
    for (const req of imageRequests) {
      try {
        const providerId = imageProviderIds[0] as ImageProviderId;
        const apiKey = resolveImageApiKey(providerId);
        const providerConfig = IMAGE_PROVIDERS[providerId];
        if (providerConfig?.requiresApiKey && !apiKey) {
          log.warn(`No API key for image provider "${providerId}", skipping ${req.elementId}`);
          continue;
        }
        const model = providerConfig?.models?.[0]?.id;

        const result = await generateImage(
          { providerId, apiKey, baseUrl: resolveImageBaseUrl(providerId), model },
          { prompt: req.prompt, aspectRatio: req.aspectRatio || '16:9' },
        );

        let buf: Buffer;
        let ext: string;
        if (result.base64) {
          buf = Buffer.from(result.base64, 'base64');
          ext = 'png';
        } else if (result.url) {
          buf = await downloadToBuffer(result.url);
          const urlExt = path.extname(new URL(result.url).pathname).replace('.', '');
          ext = ['png', 'jpg', 'jpeg', 'webp'].includes(urlExt) ? urlExt : 'png';
        } else {
          log.warn(`Image generation returned no data for ${req.elementId}`);
          continue;
        }

        const filename = `${req.elementId}.${ext}`;
        await fs.writeFile(path.join(mediaDir, filename), buf);
        mediaMap[req.elementId] = mediaServingUrl(baseUrl, classroomId, `media/${filename}`);
        log.info(`Generated image: ${filename}`);
      } catch (err) {
        log.warn(`Image generation failed for ${req.elementId}:`, err);
      }
    }
  };

  const generateVideos = async () => {
    for (const req of videoRequests) {
      try {
        const providerId = videoProviderIds[0] as VideoProviderId;
        const apiKey = resolveVideoApiKey(providerId);
        if (!apiKey) {
          log.warn(`No API key for video provider "${providerId}", skipping ${req.elementId}`);
          continue;
        }
        const providerConfig = VIDEO_PROVIDERS[providerId];
        const model = providerConfig?.models?.[0]?.id;

        const normalized = normalizeVideoOptions(providerId, {
          prompt: req.prompt,
          aspectRatio: (req.aspectRatio as '16:9' | '4:3' | '1:1' | '9:16') || '16:9',
        });

        const result = await generateVideo(
          { providerId, apiKey, baseUrl: resolveVideoBaseUrl(providerId), model },
          normalized,
        );

        const buf = await downloadToBuffer(result.url);
        const filename = `${req.elementId}.mp4`;
        await fs.writeFile(path.join(mediaDir, filename), buf);
        mediaMap[req.elementId] = mediaServingUrl(baseUrl, classroomId, `media/${filename}`);
        log.info(`Generated video: ${filename}`);
      } catch (err) {
        log.warn(`Video generation failed for ${req.elementId}:`, err);
      }
    }
  };

  await Promise.all([generateImages(), generateVideos()]);

  return mediaMap;
}

// ---------------------------------------------------------------------------
// Placeholder replacement in scene content
// ---------------------------------------------------------------------------

export function replaceMediaPlaceholders(scenes: Scene[], mediaMap: Record<string, string>): void {
  if (Object.keys(mediaMap).length === 0) return;

  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const canvas = (
      scene.content as {
        canvas?: {
          elements?: Array<{ id: string; src?: string; mediaRef?: string; type?: string }>;
        };
      }
    )?.canvas;
    if (!canvas?.elements) continue;

    for (const el of canvas.elements) {
      if (
        el.type === 'video' &&
        typeof el.mediaRef === 'string' &&
        mediaMap[el.mediaRef] &&
        (!el.src || /^gen_vid_[\w-]+$/i.test(el.src))
      ) {
        el.src = mediaMap[el.mediaRef];
        continue;
      }
      if (
        (el.type === 'image' || el.type === 'video') &&
        typeof el.src === 'string' &&
        isGeneratedMediaPlaceholder(el.src) &&
        mediaMap[el.src]
      ) {
        el.src = mediaMap[el.src];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// TTS generation
// ---------------------------------------------------------------------------

/** Statistics returned by {@link backfillMissingTTSForClassroom}. */
export interface TTSBackfillStats {
  /** Speech actions scanned. */
  total: number;
  /** (action × voice) pairs whose file was missing. */
  missing: number;
  /** Missing files successfully generated. */
  generated: number;
  /** Missing files that failed to generate. */
  failed: number;
}

/**
 * Stamp audioId/audioUrl from the set of voice files that actually exist on
 * disk (shared by generation and backfill). No-op when nothing exists.
 * Prefers the default voice as the anchor, falling back to the first existing
 * voice; uses the {voice} template URL only when the default voice exists.
 */
function stampAudioFields(
  speechAction: SpeechAction,
  baseAudioId: string,
  existingVoiceFiles: string[],
  baseUrl: string,
  classroomId: string,
  format: string,
): void {
  if (existingVoiceFiles.length === 0) return;
  const defaultVoiceFile = voiceIdToFileName(DEFAULT_PREGENERATED_VOICE);
  const anchorVoiceFile = existingVoiceFiles.includes(defaultVoiceFile)
    ? defaultVoiceFile
    : existingVoiceFiles[0];
  speechAction.audioId = `${baseAudioId}_${anchorVoiceFile}`;
  if (existingVoiceFiles.includes(defaultVoiceFile)) {
    // Default voice present — use the {voice} template so any voice can be
    // resolved at runtime; missing variants fall back in the AudioPlayer.
    speechAction.audioUrl = mediaServingUrl(
      baseUrl,
      classroomId,
      `audio/${baseAudioId}_{voice}.${format}`,
    );
  } else {
    // Default voice missing — point directly at an existing file so the
    // template never resolves to a missing variant.
    speechAction.audioUrl = mediaServingUrl(
      baseUrl,
      classroomId,
      `audio/${baseAudioId}_${anchorVoiceFile}.${format}`,
    );
  }
}

export async function generateTTSForClassroom(
  scenes: Scene[],
  classroomId: string,
  baseUrl: string,
): Promise<void> {
  const audioDir = path.join(CLASSROOMS_DIR, classroomId, 'audio');
  await ensureDir(audioDir);

  // Force MiniMax TTS as the sole provider for pre-generated multi-voice audio.
  const providerId: TTSProviderId = 'minimax-tts';
  const apiKey = resolveTTSApiKey(providerId);
  const ttsProvider = TTS_PROVIDERS[providerId];
  if (!apiKey) {
    log.warn(`No API key for TTS provider "${providerId}", skipping TTS generation`);
    return;
  }
  const ttsBaseUrl = resolveTTSBaseUrl(providerId) || ttsProvider?.defaultBaseUrl;
  const modelId = 'speech-2.8-hd';
  const format = 'mp3';

  for (const scene of scenes) {
    if (!scene.actions) continue;

    // Split long speech actions into multiple shorter ones before TTS generation,
    // mirroring the client-side approach. Each sub-action gets its own audio file.
    scene.actions = splitLongSpeechActions(scene.actions, providerId);

    // Use scene order to make audio IDs unique across scenes
    const sceneOrder = scene.order;

    for (const action of scene.actions) {
      if (action.type !== 'speech' || !(action as SpeechAction).text) continue;
      const speechAction = action as SpeechAction;
      const baseAudioId = `tts_s${sceneOrder}_${action.id}`;

      // Pre-generate audio for ALL voices so users can switch instantly.
      // Track which voices actually succeeded — a missing file must never
      // be referenced by audioId/audioUrl (the player would 404 silently).
      const generatedVoiceFiles: string[] = [];
      for (const voice of PREGENERATED_VOICES) {
        const voiceFile = voiceIdToFileName(voice);
        const audioId = `${baseAudioId}_${voiceFile}`;
        try {
          const result = await generateTTS(
            {
              providerId,
              modelId,
              apiKey,
              baseUrl: ttsBaseUrl,
              voice,
              speed: speechAction.speed,
            },
            speechAction.text,
          );

          const filename = `${audioId}.${result.format || format}`;
          await fs.writeFile(path.join(audioDir, filename), result.audio);
          generatedVoiceFiles.push(voiceFile);
          log.info(`Generated TTS: ${filename} (${result.audio.length} bytes)`);
        } catch (err) {
          log.warn(`TTS generation failed for ${audioId} (voice=${voice}):`, err);
        }
      }

      // Stamp audioId/audioUrl only for voices that really exist on disk.
      // No successful voice ⇒ leave the action unvoiced so the client falls
      // back (browser-native TTS / reading timer).
      if (generatedVoiceFiles.length === 0) {
        log.warn(`No TTS audio generated for ${baseAudioId} (all voices failed)`);
        continue;
      }
      stampAudioFields(speechAction, baseAudioId, generatedVoiceFiles, baseUrl, classroomId, format);
    }
  }
}

// ---------------------------------------------------------------------------
// TTS backfill (fill missing pre-generated voice files only)
// ---------------------------------------------------------------------------

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Backfill missing pre-generated voice audio for an existing classroom.
 *
 * Unlike {@link generateTTSForClassroom} (full regeneration), this only
 * generates (action × voice) pairs whose file does not exist on disk —
 * existing files are kept untouched (saves TTS API cost). Afterwards each
 * action's audioId/audioUrl is re-stamped from the files actually present.
 */
export async function backfillMissingTTSForClassroom(
  scenes: Scene[],
  classroomId: string,
  baseUrl: string,
): Promise<TTSBackfillStats> {
  const stats: TTSBackfillStats = { total: 0, missing: 0, generated: 0, failed: 0 };

  const audioDir = path.join(CLASSROOMS_DIR, classroomId, 'audio');
  await ensureDir(audioDir);

  const providerId: TTSProviderId = 'minimax-tts';
  const apiKey = resolveTTSApiKey(providerId);
  const ttsProvider = TTS_PROVIDERS[providerId];
  if (!apiKey) {
    log.warn(`No API key for TTS provider "${providerId}", skipping TTS backfill`);
    return stats;
  }
  const ttsBaseUrl = resolveTTSBaseUrl(providerId) || ttsProvider?.defaultBaseUrl;
  const modelId = 'speech-2.8-hd';
  const format = 'mp3';

  for (const scene of scenes) {
    if (!scene.actions) continue;
    // No-op for MiniMax (no text-length limit) — keeps parity with the
    // generation pipeline and stays safe if a limit is added later.
    scene.actions = splitLongSpeechActions(scene.actions, providerId);
    const sceneOrder = scene.order;

    for (const action of scene.actions) {
      if (action.type !== 'speech' || !(action as SpeechAction).text) continue;
      const speechAction = action as SpeechAction;
      const baseAudioId = `tts_s${sceneOrder}_${action.id}`;
      stats.total += 1;

      const existingVoiceFiles: string[] = [];
      for (const voice of PREGENERATED_VOICES) {
        const voiceFile = voiceIdToFileName(voice);
        const audioId = `${baseAudioId}_${voiceFile}`;
        if (await fileExists(path.join(audioDir, `${audioId}.${format}`))) {
          existingVoiceFiles.push(voiceFile);
          continue;
        }
        stats.missing += 1;
        try {
          const result = await generateTTS(
            {
              providerId,
              modelId,
              apiKey,
              baseUrl: ttsBaseUrl,
              voice,
              speed: speechAction.speed,
            },
            speechAction.text,
          );
          const filename = `${audioId}.${result.format || format}`;
          await fs.writeFile(path.join(audioDir, filename), result.audio);
          existingVoiceFiles.push(voiceFile);
          stats.generated += 1;
          log.info(`Backfilled TTS: ${filename} (${result.audio.length} bytes)`);
        } catch (err) {
          stats.failed += 1;
          log.warn(`TTS backfill failed for ${audioId} (voice=${voice}):`, err);
        }
      }

      // Re-stamp audioId/audioUrl from the files that actually exist now.
      stampAudioFields(speechAction, baseAudioId, existingVoiceFiles, baseUrl, classroomId, format);
    }
  }

  log.info(
    `TTS backfill complete for ${classroomId}: ${stats.total} actions, ` +
      `${stats.missing} missing, ${stats.generated} generated, ${stats.failed} failed`,
  );
  return stats;
}
