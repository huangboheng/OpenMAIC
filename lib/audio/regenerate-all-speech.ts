/**
 * 重生成课堂全部讲课音频（导师声音切换的核心执行逻辑）。
 *
 * 讲课音频在课堂生成时预合成并缓存，切换导师音色后必须逐句重新合成，
 * 播放才能听到新声音。本模块遍历当前课堂所有场景的 speech 动作，复用
 * 生成管线的 {@link regenerateSpeechAudio}（内部走 generateAndStoreTTS，
 * 读取全局 settings.ttsVoice），成功后把规范 audioId 写回动作，确保播放
 * 读取路径（resolveSpeechAudioId）命中新音频。
 *
 * 进度与防重入由 {@link useVoiceRegenStore} 统一管理：按钮组件显示进度、
 * 播放路径据此门控。
 */
import { useStageStore } from '@/lib/store';
import { regenerateSpeechAudio, speechAudioId } from '@/lib/audio/regenerate-speech-tts';
import { setAudioIdById } from '@/components/edit/ActionsBar/actions-edit';
import { useVoiceRegenStore } from '@/lib/store/voice-regen';

/** 待重生成的单句讲课语音目标。 */
interface SpeechTarget {
  sceneId: string;
  order: number;
  actionId: string;
  text: string;
}

/** 收集当前课堂所有场景中含文本的 speech 动作。 */
function collectSpeechTargets(): SpeechTarget[] {
  const scenes = useStageStore.getState().scenes;
  const targets: SpeechTarget[] = [];
  for (const scene of scenes) {
    const order = scene.order ?? 0;
    for (const action of scene.actions ?? []) {
      if (action.type !== 'speech') continue;
      const text = (action as { text?: string }).text?.trim();
      if (!text || !action.id) continue;
      targets.push({ sceneId: scene.id, order, actionId: action.id, text });
    }
  }
  return targets;
}

/**
 * 重新合成本课堂全部讲课音频。
 *
 * 前置条件：调用方须已设置 ttsProviderId / ttsVoice 并启用 ttsEnabled
 * （否则 regenerateSpeechAudio 会因 isManagedTtsActive 为 false 而跳过）。
 *
 * 防重入：已有批次进行时直接返回，避免重复触发。
 *
 * @param signal 可选中止信号。
 * @returns 失败的句数（0 表示全部成功）。
 */
export async function regenerateAllSpeech(signal?: AbortSignal): Promise<number> {
  if (useVoiceRegenStore.getState().running) return 0;

  const targets = collectSpeechTargets();
  if (targets.length === 0) return 0;

  // 语言与生成管线一致：优先取舞台的 languageDirective。
  const language = useStageStore.getState().stage?.languageDirective;

  useVoiceRegenStore.getState().start(targets.length);
  let failed = 0;

  for (const target of targets) {
    if (signal?.aborted) break;
    try {
      const id = await regenerateSpeechAudio(
        target.order,
        { id: target.actionId, text: target.text },
        language,
        signal,
      );
      if (id) {
        // 成功后立即把规范 audioId 写回动作，播放即读取新音频。
        const scene = useStageStore.getState().scenes.find((s) => s.id === target.sceneId);
        if (scene) {
          const nextActions = setAudioIdById(
            scene.actions ?? [],
            target.actionId,
            speechAudioId(target.order, target.actionId),
          );
          useStageStore.getState().updateScene(target.sceneId, { actions: nextActions });
        }
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
    useVoiceRegenStore.getState().tick();
  }

  if (failed > 0) {
    useVoiceRegenStore.getState().fail(`${failed} 段语音生成失败`);
  } else {
    useVoiceRegenStore.getState().finish();
  }

  return failed;
}
