/**
 * 试看/预览状态存储。
 *
 * 试看期间切换导师声音会触发全课堂 TTS 重生成（产生 API 费用），
 * 因此试看窗口内应禁用声音切换按钮。该存储为「当前是否处于试看期」
 * 的单一事实来源，由 {@link usePreviewTimer} 写入，
 * {@link MentorVoiceSwitcher} 读取以门控切换操作。
 *
 * 该状态为瞬态（不持久化）：仅描述当前课堂页面的试看生命周期。
 */
import { create } from 'zustand';

interface PreviewStore {
  /** 当前是否处于免费试看窗口内（未过期） */
  isTrial: boolean;
  setIsTrial: (v: boolean) => void;
}

export const usePreviewStore = create<PreviewStore>((set) => ({
  isTrial: false,
  setIsTrial: (v) => set({ isTrial: v }),
}));
