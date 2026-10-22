/**
 * AudioPlayer voice-aware URL fallback tests.
 *
 * Pre-generated multi-voice classrooms may miss individual voice files
 * (TTS generation failures). The player must never 404 silently: it falls
 * back current-voice URL → default-voice URL → IndexedDB → false.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveAudioBlobMock = vi.fn();
vi.mock('@/lib/media/resolve-audio-bytes', () => ({
  resolveAudioBlob: resolveAudioBlobMock,
  resolveAudioBlobs: vi.fn(),
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: () => ({ ttsVoice: 'male-qn-jingying' }) },
}));

let fetchBehaviors: Array<() => Promise<{ ok: boolean; blob?: () => Promise<Blob> }>> = [];
let fetchedUrls: string[] = [];
let instances: Array<{ src: string; play: ReturnType<typeof vi.fn> }>;

function stubFetch() {
  vi.stubGlobal('fetch', (url: string) => {
    fetchedUrls.push(String(url));
    const behavior =
      fetchBehaviors.shift() ??
      (() =>
        Promise.resolve({
          ok: true,
          blob: () => Promise.resolve(new Blob(['audio'])),
        }));
    return behavior();
  });
}

function stubAudio() {
  class AudioStub {
    src = '';
    volume = 1;
    defaultPlaybackRate = 1;
    playbackRate = 1;
    currentTime = 0;
    preload = '';
    onended: (() => void) | null = null;
    play = vi.fn(() => Promise.resolve());
    addEventListener = vi.fn();
    removeAttribute = vi.fn();
    load = vi.fn();
    pause = vi.fn();
    constructor() {
      instances.push(this as unknown as { src: string; play: ReturnType<typeof vi.fn> });
    }
  }
  vi.stubGlobal('Audio', AudioStub);
}

function stubObjectUrl() {
  const createObjectURL = vi.fn(() => 'blob:fake-url');
  const revokeObjectURL = vi.fn();
  class URLStub extends URL {}
  Object.assign(URLStub, { createObjectURL, revokeObjectURL });
  vi.stubGlobal('URL', URLStub);
  return { createObjectURL, revokeObjectURL };
}

const TEMPLATE_URL =
  'http://base.test/api/classroom-media/room1/audio/tts_s1_act1_{voice}.mp3';

describe('AudioPlayer URL fallback chain', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    resolveAudioBlobMock.mockReset();
    fetchBehaviors = [];
    fetchedUrls = [];
    instances = [];
  });

  it('plays the current-voice URL on first success (no fallback)', async () => {
    stubObjectUrl();
    stubAudio();
    stubFetch();

    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const ok = await new AudioPlayer().play('tts_s1_act1_female-yujie', TEMPLATE_URL);

    expect(ok).toBe(true);
    expect(fetchedUrls).toHaveLength(1);
    expect(fetchedUrls[0]).toContain('male-qn-jingying');
    expect(resolveAudioBlobMock).not.toHaveBeenCalled();
  });

  it('missing current-voice file falls back to the default voice URL', async () => {
    stubObjectUrl();
    stubAudio();
    fetchBehaviors = [
      () => Promise.resolve({ ok: false }), // current voice 404
      () =>
        Promise.resolve({
          ok: true,
          blob: () => Promise.resolve(new Blob(['audio'])),
        }), // default voice ok
    ];
    stubFetch();

    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const ok = await new AudioPlayer().play('tts_s1_act1_female-yujie', TEMPLATE_URL);

    expect(ok).toBe(true);
    expect(fetchedUrls).toHaveLength(2);
    expect(fetchedUrls[0]).toContain('male-qn-jingying');
    expect(fetchedUrls[1]).toContain('female-yujie');
    expect(resolveAudioBlobMock).not.toHaveBeenCalled();
  });

  it('both voice URLs failing fall back to the IndexedDB cache', async () => {
    const { createObjectURL } = stubObjectUrl();
    stubAudio();
    fetchBehaviors = [
      () => Promise.resolve({ ok: false }),
      () => Promise.resolve({ ok: false }),
    ];
    stubFetch();
    resolveAudioBlobMock.mockResolvedValue(new Blob(['audio']));

    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const ok = await new AudioPlayer().play('tts_s1_act1_female-yujie', TEMPLATE_URL);

    expect(ok).toBe(true);
    expect(createObjectURL).toHaveBeenCalled();
    expect(resolveAudioBlobMock).toHaveBeenCalled();
  });

  it('returns false when every source is unavailable (engine falls back to timer)', async () => {
    stubObjectUrl();
    stubAudio();
    fetchBehaviors = [
      () => Promise.resolve({ ok: false }),
      () => Promise.resolve({ ok: false }),
    ];
    stubFetch();
    resolveAudioBlobMock.mockResolvedValue(null);

    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const ok = await new AudioPlayer().play('tts_s1_act1_female-yujie', TEMPLATE_URL);

    expect(ok).toBe(false);
  });

  it('non-template URL failure falls straight to IndexedDB (no second URL try)', async () => {
    stubObjectUrl();
    stubAudio();
    fetchBehaviors = [() => Promise.resolve({ ok: false })];
    stubFetch();
    resolveAudioBlobMock.mockResolvedValue(new Blob(['audio']));

    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const directUrl = 'http://base.test/api/classroom-media/room1/audio/tts_s1_act1_x.mp3';
    const ok = await new AudioPlayer().play('tts_s1_act1_female-yujie', directUrl);

    expect(ok).toBe(true);
    expect(fetchedUrls).toEqual([directUrl]);
    expect(resolveAudioBlobMock).toHaveBeenCalled();
  });
});
