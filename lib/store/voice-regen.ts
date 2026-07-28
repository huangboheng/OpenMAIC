/**
 * 导师语音重生成状态存储。
 *
 * 切换导师音色需要重新合成课堂内全部讲课音频（逐句调用 TTS，耗时较长）。
 * 该存储是"重生成进行中"这一事实的单一来源：
 * - 声音切换按钮读取它显示进度（done/total）并禁用重复触发；
 * - 讲课播放路径读取 running 门控播放，避免重生成期间播放到旧（脏）音频。
 *
 * 该状态为瞬态（不持久化）：仅描述一次重生成批次的生命周期。
 */
import { create } from 'zustand';

export interface VoiceRegenState {
  /** 是否有重生成批次正在进行 */
  running: boolean;
  /** 已完成（成功或失败）的句数 */
  done: number;
  /** 本批次总句数 */
  total: number;
  /** 结束时的错误信息（部分/全部失败），null 表示无错误 */
  error: string | null;
  /** 开始一个批次 */
  start: (total: number) => void;
  /** 完成一句（成功或失败均计数） */
  tick: () => void;
  /** 批次成功结束 */
  finish: () => void;
  /** 批次以错误结束（部分/全部失败） */
  fail: (error: string) => void;
  /** 清除错误状态 */
  clearError: () => void;
}

export const useVoiceRegenStore = create<VoiceRegenState>((set) => ({
  running: false,
  done: 0,
  total: 0,
  error: null,
  start: (total) => set({ running: true, done: 0, total, error: null }),
  tick: () => set((s) => ({ done: s.done + 1 })),
  finish: () => set({ running: false }),
  fail: (error) => set({ running: false, error }),
  clearError: () => set({ error: null }),
}));
