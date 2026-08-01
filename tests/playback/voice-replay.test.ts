import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlaybackEngine } from '@/lib/playback/engine';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { ActionEngine } from '@/lib/action/engine';
import type { AudioPlayer } from '@/lib/utils/audio-player';

function speech(id: string, text = id): Action {
  return { id, type: 'speech', text } as Action;
}

function scene(actions: Action[]): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Scene 1',
    order: 1,
    content: { type: 'slide', canvas: {} },
    actions,
  } as unknown as Scene;
}

function createActionEngine() {
  return {
    execute: vi.fn(),
    clearEffects: vi.fn(),
    resetPlaybackVisualState: vi.fn(),
  } as unknown as ActionEngine;
}

function createAudioPlayer(playResult = true) {
  let ended: (() => void) | null = null;
  const player = {
    play: vi.fn(async () => playResult),
    onEnded: vi.fn((callback: () => void) => {
      ended = callback;
    }),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    isPlaying: vi.fn(() => false),
    hasActiveAudio: vi.fn(() => false),
    setPlaybackRate: vi.fn(),
    setMuted: vi.fn(),
    setVolume: vi.fn(),
    destroy: vi.fn(),
  } as unknown as AudioPlayer;
  return { player, fireEnded: () => ended?.() };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('PlaybackEngine.replayCurrentSpeech (voice switch)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('replays the current speech action when playing (audio re-resolved)', async () => {
    const actionEngine = createActionEngine();
    const { player } = createAudioPlayer(true);
    const onSpeechStart = vi.fn();
    const engine = new PlaybackEngine(
      [scene([speech('a', 'Hello'), speech('b', 'World')])],
      actionEngine,
      player,
      { onSpeechStart },
    );

    engine.start();
    await flushPromises();

    // First speech started
    expect(onSpeechStart).toHaveBeenCalledTimes(1);
    expect(onSpeechStart).toHaveBeenCalledWith('Hello');
    expect(player.play).toHaveBeenCalledTimes(1);

    // Simulate voice switch → replay current sentence
    engine.replayCurrentSpeech();
    await flushPromises();

    // Same action replayed: onSpeechStart fired again with same text,
    // AudioPlayer.play called again (fresh voice resolution)
    expect(onSpeechStart).toHaveBeenCalledTimes(2);
    expect(onSpeechStart).toHaveBeenLastCalledWith('Hello');
    expect(player.play).toHaveBeenCalledTimes(2);
    // Old audio stopped before replay
    expect(player.stop).toHaveBeenCalled();
  });

  it('does not advance to the next action after replay', async () => {
    const actionEngine = createActionEngine();
    const { player, fireEnded } = createAudioPlayer(true);
    const onSpeechStart = vi.fn();
    const engine = new PlaybackEngine(
      [scene([speech('a', 'Hello'), speech('b', 'World')])],
      actionEngine,
      player,
      { onSpeechStart },
    );

    engine.start();
    await flushPromises();
    engine.replayCurrentSpeech();
    await flushPromises();

    // After replay, ending the audio advances to the SECOND speech —
    // proving the cursor stayed on action 'a' during replay.
    fireEnded();
    await flushPromises();

    expect(onSpeechStart).toHaveBeenCalledTimes(3);
    expect(onSpeechStart).toHaveBeenLastCalledWith('World');
  });

  it('does not trigger playback when paused (cursor stays for resume)', async () => {
    const actionEngine = createActionEngine();
    const { player } = createAudioPlayer(true);
    const engine = new PlaybackEngine(
      [scene([speech('a', 'Hello'), speech('b', 'World')])],
      actionEngine,
      player,
    );

    engine.start();
    await flushPromises();
    engine.pause();

    const playCallsBefore = (player.play as ReturnType<typeof vi.fn>).mock.calls.length;

    engine.replayCurrentSpeech();
    await flushPromises();

    // No new play call while paused — resume() will replay with new voice
    expect((player.play as ReturnType<typeof vi.fn>).mock.calls.length).toBe(playCallsBefore);
    // Audio was stopped (old voice silenced)
    expect(player.stop).toHaveBeenCalled();
  });

  it('is a no-op when the current action is not speech', async () => {
    const actionEngine = createActionEngine();
    const { player, fireEnded } = createAudioPlayer(true);
    const engine = new PlaybackEngine(
      [
        scene([
          speech('a', 'Hello'),
          { id: 'spot-1', type: 'spotlight', elementId: 'box' } as Action,
        ]),
      ],
      actionEngine,
      player,
    );

    engine.start();
    await flushPromises();
    expect(player.play).toHaveBeenCalledTimes(1);

    // End the speech → spotlight fires (fire-and-forget) → engine exhausts
    // its actions and goes idle. The last-started action is the spotlight.
    fireEnded();
    await flushPromises();
    await flushPromises();
    expect(engine.getMode()).toBe('idle');

    // replayCurrentSpeech is a no-op: last action wasn't speech / engine idle
    engine.replayCurrentSpeech();
    await flushPromises();
    expect(player.play).toHaveBeenCalledTimes(1); // unchanged
  });

  it('is a no-op when engine is idle', async () => {
    const actionEngine = createActionEngine();
    const { player } = createAudioPlayer(true);
    const engine = new PlaybackEngine([scene([speech('a', 'Hello')])], actionEngine, player);

    // Never started — mode is idle
    engine.replayCurrentSpeech();
    await flushPromises();

    expect(player.play).not.toHaveBeenCalled();
  });

  it('invalidates the old generation so stale onEnded cannot double-advance', async () => {
    const actionEngine = createActionEngine();
    const { player, fireEnded } = createAudioPlayer(true);
    const onSpeechStart = vi.fn();
    const engine = new PlaybackEngine(
      [scene([speech('a', 'Hello'), speech('b', 'World')])],
      actionEngine,
      player,
      { onSpeechStart },
    );

    engine.start();
    await flushPromises();

    // Voice switch mid-sentence
    engine.replayCurrentSpeech();
    await flushPromises();

    // The OLD audio element's ended callback fires (stale) — must be ignored.
    // Only the new generation's ended (fired below) should advance.
    fireEnded(); // This is the NEW ended callback (onEnded was re-wired by replay)
    await flushPromises();

    // Exactly one advance: to 'World'
    expect(onSpeechStart).toHaveBeenCalledTimes(3); // Hello, Hello(replay), World
    expect(onSpeechStart).toHaveBeenLastCalledWith('World');
  });
});
