'use client';

import { useEffect, useState } from 'react';
import { usePreviewStore } from '@/lib/store/preview';

const FREE_PREVIEW_MINUTES = 10;
const STORAGE_KEY_PREFIX = 'openmaic.preview';

export interface PreviewTimerState {
  /** 是否已经超时 */
  expired: boolean;
  /** 剩余秒数（未超时有效） */
  remainingSeconds: number;
}

/**
 * 课堂内免费试看计时 Hook
 *
 * 在课堂页面挂载时通过 localStorage 记录首次访问时间，
 * 超过 10 分钟后设置 expired=true，由调用方展示阻断提示。
 *
 * 每次重新进入课堂（新 classroomId / 新窗口）都重新计时。
 */
export function usePreviewTimer(classroomId: string): PreviewTimerState {
  const [expired, setExpired] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(
    FREE_PREVIEW_MINUTES * 60,
  );

  const setIsTrial = usePreviewStore((s) => s.setIsTrial);

  useEffect(() => {
    if (!classroomId) return;

    const key = `${STORAGE_KEY_PREFIX}.${classroomId}`;
    let timerId: ReturnType<typeof setInterval>;

    try {
      const stored = localStorage.getItem(key);
      const now = Date.now();
      let startTime: number;

      if (!stored) {
        startTime = now;
        localStorage.setItem(key, String(startTime));
      } else {
        startTime = parseInt(stored, 10);
        // 时间戳非法，或距上一轮首次访问已超过 10 分钟（上一轮试看已过期），
        // 均视为全新一轮访问并重置计时起点——保证用户过期后重新进入课堂能
        // 获得完整新一轮试看，而不会"一旦过期、永久阻断"。
        // （与覆盖层文案"重新打开课堂即可开始新一轮 10 分钟试看"一致）
        if (isNaN(startTime) || now - startTime >= FREE_PREVIEW_MINUTES * 60 * 1000) {
          startTime = now;
          localStorage.setItem(key, String(startTime));
        }
      }

      const tick = () => {
        const elapsed = (Date.now() - startTime) / 1000;
        const remaining = Math.max(0, FREE_PREVIEW_MINUTES * 60 - elapsed);
        setRemainingSeconds(Math.ceil(remaining));
        if (remaining <= 0) {
          setExpired(true);
          clearInterval(timerId);
        }
      };

      // 立即执行一次检查
      tick();

      // 每秒更新倒计时
      timerId = setInterval(tick, 1000);

      // 试看窗口内（未过期）同步到全局 store，供声音切换器等禁用按钮。
      // NEXT_PUBLIC_SKIP_PREVIEW_TRIAL 为 E2E / 开发调试提供逃生舱。
      if (!process.env.NEXT_PUBLIC_SKIP_PREVIEW_TRIAL) {
        setIsTrial(true);
      }
    } catch {
      // localStorage 不可用：静默降级，不限制
    }

    return () => {
      clearInterval(timerId);
      setIsTrial(false);
      // 离开课堂即清除计时起点，下次进入重新获得完整 10 分钟试看
      // （与覆盖层文案"重新打开课堂即可开始新一轮 10 分钟试看"一致）
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
    };
  }, [classroomId]);

  return { expired, remainingSeconds };
}
