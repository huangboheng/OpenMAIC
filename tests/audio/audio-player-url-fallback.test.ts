/**
 * AudioPlayer voice-aware URL fallback tests.
 *
 * Pre-generated multi-voice classrooms may miss individual voice files
 * (TTS generation failures). The player must never 404 silently: it falls
 * back current-voice URL → default-voice URL → IndexedDB → false.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getMock = vi.fn();
vi.mock('@/lib/utils/database', () => ({
  db: { audioFiles: { get: getMock } },
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: () => ({ ttsVoice: 'male-qn-jingying' }) },
}));

/** Play behaviors consumed in order by each `new Audio()` stub. */
let playBehaviors: Array<() => Promise<void>> = [];
let instances: Array<{ src: string; play: ReturnType<typeof vi.fn> }>;

function stubAudio() {
  class AudioStub {
    src = '';
    volume = 1;
    defaultPlaybackRate = 1;
    playbackRate = 1;
    currentTime = 0;
    play = vi.fn(() => {
      const behavior = playBehaviors.shift() ?? (() => Promise.resolve());
      return behavior();
    });
    addEventListener = vi.fn();
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
    getMock.mockReset();
    playBehaviors = [];
    instances = [];
  });

  it('plays the current-voice URL on first success (no fallback)', async () => {
    stubObjectUrl();
    stubAudio();
    playBehaviors = [() => Promise.resolve()];

    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const ok = await new AudioPlayer().play('tts_s1_act1_female-yujie', TEMPLATE_URL);

    expect(ok).toBe(true);
    expect(instances).toHaveLength(1);
    expect(instances[0].src).toContain('male-qn-jingying');
    expect(getMock).not.toHaveBeenCalled();
  });

  it('missing current-voice file falls back to the default voice URL', async () => {
    stubObjectUrl();
    stubAudio();
    playBehaviors = [
      () => Promise.reject(new Error('NotSupportedError')), // current voice 404
      () => Promise.resolve(), // default voice ok
    ];

    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const ok = await new AudioPlayer().play('tts_s1_act1_female-yujie', TEMPLATE_URL);

    expect(ok).toBe(true);
    expect(instances).toHaveLength(2);
    expect(instances[0].src).toContain('male-qn-jingying');
    expect(instances[1].src).toContain('female-yujie');
    expect(getMock).not.toHaveBeenCalled();
  });

  it('both voice URLs failing fall back to the IndexedDB cache', async () => {
    const { createObjectURL } = stubObjectUrl();
    stubAudio();
    playBehaviors = [
      () => Promise.reject(new Error('404')),
      () => Promise.reject(new Error('404')),
      () => Promise.resolve(), // blob playback
    ];
    getMock.mockResolvedValue({ blob: new Blob(['audio']) });

    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const ok = await new AudioPlayer().play('tts_s1_act1_female-yujie', TEMPLATE_URL);

    expect(ok).toBe(true);
    expect(createObjectURL).toHaveBeenCalled();
    expect(getMock).toHaveBeenCalled();
  });

  it('returns false when every source is unavailable (engine falls back to timer)', async () => {
    stubObjectUrl();
    stubAudio();
    playBehaviors = [
      () => Promise.reject(new Error('404')),
      () => Promise.reject(new Error('404')),
    ];
    getMock.mockResolvedValue(undefined);

    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const ok = await new AudioPlayer().play('tts_s1_act1_female-yujie', TEMPLATE_URL);

    expect(ok).toBe(false);
  });

  it('non-template URL failure falls straight to IndexedDB (no second URL try)', async () => {
    stubObjectUrl();
    stubAudio();
    playBehaviors = [
      () => Promise.reject(new Error('404')),
      () => Promise.resolve(), // blob playback
    ];
    getMock.mockResolvedValue({ blob: new Blob(['audio']) });

    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const directUrl = 'http://base.test/api/classroom-media/room1/audio/tts_s1_act1_x.mp3';
    const ok = await new AudioPlayer().play('tts_s1_act1_female-yujie', directUrl);

    expect(ok).toBe(true);
    // One URL attempt + one blob playback — no default-voice retry.
    expect(instances).toHaveLength(2);
    expect(instances[0].src).toBe(directUrl);
  });
});
