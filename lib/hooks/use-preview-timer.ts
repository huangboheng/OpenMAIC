'use client';

import { useEffect, useState } from 'react';

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
        if (isNaN(startTime)) {
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
    } catch {
      // localStorage 不可用：静默降级，不限制
    }

    return () => {
      clearInterval(timerId);
    };
  }, [classroomId]);

  return { expired, remainingSeconds };
}
