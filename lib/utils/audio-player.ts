/**
 * Audio Player - Audio player interface
 *
 * Handles audio playback, pause, stop, and other operations
 * Loads pre-generated TTS audio files from IndexedDB
 *
 */

import { db } from '@/lib/utils/database';
import { createLogger } from '@/lib/logger';
import { useSettingsStore } from '@/lib/store/settings';
import { DEFAULT_PREGENERATED_VOICE, voiceIdToFileName } from '@/lib/audio/constants';

const log = createLogger('AudioPlayer');

/**
 * Audio player implementation
 */
export class AudioPlayer {
  private audio: HTMLAudioElement | null = null;
  private onEndedCallback: (() => void) | null = null;
  private muted: boolean = false;
  private volume: number = 1;
  private playbackRate: number = 1;
  private requestToken: number = 0;

  private stopAudioElement(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio = null;
    }
  }

  /**
   * Play audio (from URL or IndexedDB pre-generated cache).
   *
   * Voice-aware resolution:
   * - audioUrl may contain a `{voice}` template placeholder (server-generated
   *   classrooms) which is replaced with the current voice's file-safe id.
   * - For IndexedDB, tries: audioId as-is (already voice-suffixed by the
   *   generation pipeline), then falls back to the default voice variant,
   *   then to the raw audioId (legacy classrooms without voice suffix).
   *
   * @param audioId Audio ID (may already include voice suffix from new pipeline)
   * @param audioUrl Optional server-generated audio URL (may contain {voice} template)
   * @returns true if audio started playing, false if no audio found
   */
  public async play(audioId: string, audioUrl?: string): Promise<boolean> {
    const requestToken = ++this.requestToken;
    const currentVoice = useSettingsStore.getState().ttsVoice || DEFAULT_PREGENERATED_VOICE;
    const voiceFile = voiceIdToFileName(currentVoice);
    const defaultVoiceFile = voiceIdToFileName(DEFAULT_PREGENERATED_VOICE);
  
    try {
      // 1. Try audioUrl first (server-generated TTS)
      if (audioUrl) {
        // Resolve {voice} template in URL (multi-voice pre-generation format)
        const resolvedUrl = audioUrl.includes('{voice}')
          ? audioUrl.replace('{voice}', voiceFile)
          : audioUrl;
  
        this.stopAudioElement();
        if (requestToken !== this.requestToken) return false;
        this.audio = new Audio();
        this.audio.src = resolvedUrl;
        if (this.muted) this.audio.volume = 0;
        else this.audio.volume = this.volume;
        this.audio.defaultPlaybackRate = this.playbackRate;
        this.audio.playbackRate = this.playbackRate;
        this.audio.addEventListener('ended', () => {
          this.onEndedCallback?.();
        });
        await this.audio.play();
        if (requestToken !== this.requestToken) return false;
        this.audio.playbackRate = this.playbackRate;
        return true;
      }
  
      // 2. Fall back to IndexedDB (client-generated TTS) with voice-aware lookup.
      // The audioId from the new pipeline already contains the default voice suffix.
      // We try to swap it to the current voice, then fall back.
      const audioRecord = await this.resolveAudioRecord(
        audioId,
        voiceFile,
        defaultVoiceFile,
      );
      if (requestToken !== this.requestToken) return false;
  
      if (!audioRecord) {
        return false;
      }
  
      // Stop current playback
      this.stopAudioElement();
      if (requestToken !== this.requestToken) return false;
  
      // Create audio element
      this.audio = new Audio();
  
      // Set audio source
      const blobUrl = URL.createObjectURL(audioRecord.blob);
      this.audio.src = blobUrl;
      if (this.muted) this.audio.volume = 0;
      else this.audio.volume = this.volume;
  
      // Apply playback rate
      this.audio.defaultPlaybackRate = this.playbackRate;
      this.audio.playbackRate = this.playbackRate;
  
      // Set ended callback
      this.audio.addEventListener('ended', () => {
        URL.revokeObjectURL(blobUrl);
        this.onEndedCallback?.();
      });
  
      try {
        await this.audio.play();
      } catch (playError) {
        URL.revokeObjectURL(blobUrl);
        throw playError;
      }
      if (requestToken !== this.requestToken) {
        URL.revokeObjectURL(blobUrl);
        return false;
      }
      this.audio.playbackRate = this.playbackRate;
      return true;
    } catch (error) {
      log.error('Failed to play audio:', error);
      throw error;
    }
  }
  
  /**
   * Voice-aware IndexedDB audio resolution.
   *
   * The audioId from the pre-generation pipeline is formatted as:
   *   `tts_s<order>_<actionId>_<defaultVoiceFile>`
   *
   * To switch voice, we replace the default voice suffix with the current one.
   * Fallback chain:
   *   1. audioId with current voice suffix (swap default → current)
   *   2. audioId as-is (already the default voice)
   *   3. raw audioId without any voice suffix (legacy classrooms)
   */
  private async resolveAudioRecord(
    audioId: string,
    currentVoiceFile: string,
    defaultVoiceFile: string,
  ): Promise<{ blob: Blob; format?: string } | undefined> {
    // If current voice IS the default, just look up audioId directly.
    if (currentVoiceFile === defaultVoiceFile) {
      const rec = await db.audioFiles.get(audioId);
      if (rec) return rec;
      // Legacy fallback: strip voice suffix
      const legacyId = audioId.endsWith(`_${defaultVoiceFile}`)
        ? audioId.slice(0, -(`_${defaultVoiceFile}`).length)
        : undefined;
      if (legacyId) return db.audioFiles.get(legacyId);
      return undefined;
    }
  
    // Try swapping default voice suffix → current voice suffix
    if (audioId.endsWith(`_${defaultVoiceFile}`)) {
      const base = audioId.slice(0, -(`_${defaultVoiceFile}`).length);
      const currentVoiceId = `${base}_${currentVoiceFile}`;
      const rec = await db.audioFiles.get(currentVoiceId);
      if (rec) return rec;
    }
  
    // Fallback: try audioId as-is (default voice)
    const rec = await db.audioFiles.get(audioId);
    if (rec) return rec;
  
    // Legacy fallback: raw audioId without voice suffix
    const legacyId = audioId.endsWith(`_${defaultVoiceFile}`)
      ? audioId.slice(0, -(`_${defaultVoiceFile}`).length)
      : undefined;
    if (legacyId) return db.audioFiles.get(legacyId);
  
    return undefined;
  }

  /**
   * Pause playback
   */
  public pause(): void {
    this.requestToken += 1;
    if (this.audio && !this.audio.paused) {
      this.audio.pause();
    }
  }

  /**
   * Stop playback
   */
  public stop(): void {
    this.requestToken += 1;
    this.stopAudioElement();
    // Note: onEndedCallback intentionally NOT cleared here because play()
    // calls stop() internally — clearing would break the callback chain.
    // Stale callbacks are harmless: engine mode check prevents processNext().
  }

  /**
   * Resume playback
   */
  public resume(): void {
    if (this.audio?.paused) {
      this.audio.playbackRate = this.playbackRate;
      this.audio.play().catch((error) => {
        log.error('Failed to resume audio:', error);
      });
    }
  }

  /**
   * Get current playback status (actively playing, not paused)
   */
  public isPlaying(): boolean {
    return this.audio !== null && !this.audio.paused;
  }

  /**
   * Whether there is active audio (playing or paused, but not ended)
   * Used to decide whether to resume playback or skip to the next line
   */
  public hasActiveAudio(): boolean {
    return this.audio !== null;
  }

  /**
   * Get current playback time (milliseconds)
   */
  public getCurrentTime(): number {
    return this.audio ? this.audio.currentTime * 1000 : 0;
  }

  /**
   * Get audio duration (milliseconds)
   */
  public getDuration(): number {
    return this.audio && !isNaN(this.audio.duration) ? this.audio.duration * 1000 : 0;
  }

  /**
   * Set playback ended callback
   */
  public onEnded(callback: () => void): void {
    this.onEndedCallback = callback;
  }

  /**
   * Set mute state (takes effect immediately on currently playing audio)
   */
  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.audio) {
      this.audio.volume = muted ? 0 : this.volume;
    }
  }

  /**
   * Set volume (0-1)
   */
  public setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.audio && !this.muted) {
      this.audio.volume = this.volume;
    }
  }

  /**
   * Set playback speed (takes effect immediately on currently playing audio)
   */
  public setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.5, Math.min(2, rate));
    if (this.audio) {
      this.audio.playbackRate = this.playbackRate;
    }
  }

  /**
   * Destroy the player
   */
  public destroy(): void {
    this.stop();
    this.onEndedCallback = null;
  }
}

/**
 * Create an audio player instance
 */
export function createAudioPlayer(): AudioPlayer {
  return new AudioPlayer();
}
