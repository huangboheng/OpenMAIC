'use client';

import { useEffect } from 'react';
import { useSettingsStore } from '@/lib/store/settings';
import type { TTSProviderId } from '@/lib/audio/types';

/**
 * Philochora 导师声音同步（嵌入场景）。
 *
 * 当 OpenMAIC 课堂以 iframe 形式嵌入 Philochora 课程详情页时，父页面需要
 * 一个课堂之外的入口来选择 AI 导师的朗读音色（托管部署下设置面板被
 * `isSettingsEnabled()` 门控隐藏）。本 Hook 负责父子页面之间的声音协议：
 *
 * 1. 挂载后向父页面发送握手消息 `{ type: 'openmaic-classroom-ready' }`，
 *    告知课堂已就绪、设置存储可用，父页面随后可下发声音配置。
 * 2. 监听父页面的 `{ type: 'openmaic-set-voice', ttsProviderId, ttsVoice }`
 *    消息，将其写入全局设置存储（导师声音的单一事实来源），讲课与讨论
 *    的 TTS 均读取该设置，从而让导师朗读音色随父页面的选择即时生效。
 *
 * 独立部署（无父页面）时握手 `postMessage` 静默失败，不产生任何副作用。
 */
export function usePhilochoraVoiceSync(): void {
  const setTTSProvider = useSettingsStore((s) => s.setTTSProvider);
  const setTTSVoice = useSettingsStore((s) => s.setTTSVoice);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data as
        | { type?: string; ttsProviderId?: string; ttsVoice?: string }
        | undefined;
      if (!data || data.type !== 'openmaic-set-voice') return;

      const { ttsProviderId, ttsVoice } = data;
      if (!ttsProviderId || !ttsVoice) return;

      // 先设 provider 再设 voice：setTTSProvider 在 provider 变化时会把
      // voice 重置为该 provider 的默认值，随后 setTTSVoice 覆盖为目标音色。
      setTTSProvider(ttsProviderId as TTSProviderId);
      setTTSVoice(ttsVoice);
    };

    window.addEventListener('message', handler);

    // 握手：通知父页面课堂已就绪，可以下发声音配置。
    try {
      window.parent.postMessage({ type: 'openmaic-classroom-ready' }, '*');
    } catch {
      /* 独立部署无父页面，忽略 */
    }

    return () => window.removeEventListener('message', handler);
  }, [setTTSProvider, setTTSVoice]);
}
