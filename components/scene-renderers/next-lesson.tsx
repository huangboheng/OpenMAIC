'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, Repeat } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useContinuousLearning } from '@/lib/hooks/use-continuous-learning';
import { Switch } from '@/components/ui/switch';

const COUNTDOWN_SECONDS = 5;

/**
 * 连续学习“下一节”导航横幅。
 *
 * 挂载于课堂完成页（ClassroomCompletePage）：
 * - 无章节序列（非 Philochora 连续学习上下文）时不渲染；
 * - 有下一节时：开启连续学习 → 可取消的倒计时自动跳转；关闭 → 手动进入按钮；
 * - 已是最后一节时：显示课程全部完成提示。
 */
export function NextLessonBanner() {
  const { t } = useI18n();
  const {
    hasSequence,
    hasNext,
    isLast,
    nextChapter,
    currentIndex,
    total,
    continuous,
    toggleContinuous,
    goToNextLesson,
  } = useContinuousLearning();

  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [cancelled, setCancelled] = useState(false);

  // 可取消的倒计时：仅在开启连续学习、存在下一节且未取消时运行
  useEffect(() => {
    if (!continuous || !hasNext || cancelled) return;
    setCountdown(COUNTDOWN_SECONDS);
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(timer);
          goToNextLesson();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [continuous, hasNext, cancelled, goToNextLesson]);

  // 非连续学习上下文：不渲染
  if (!hasSequence) return null;

  // 全部章节学完
  if (isLast || !hasNext) {
    return (
      <div className="w-full rounded-2xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 px-6 py-5 flex items-center gap-3">
        <CheckCircle2 className="w-6 h-6 text-emerald-500 shrink-0" />
        <div className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
          {t('continuousLearning.courseAllComplete')}
        </div>
      </div>
    );
  }

  const nextTitle = nextChapter?.title ?? '';

  return (
    <div className="w-full rounded-2xl bg-white/90 dark:bg-gray-900/70 border border-amber-200 dark:border-amber-900/50 px-6 py-5 shadow-sm space-y-4">
      {/* 连续学习开关（用户偏好） */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          <Repeat className="w-4 h-4 text-amber-500" />
          <span>{t('continuousLearning.toggleLabel')}</span>
        </div>
        <Switch
          checked={continuous}
          onCheckedChange={(v) => {
            toggleContinuous(v);
            if (v) setCancelled(false);
          }}
        />
      </div>

      {continuous && !cancelled ? (
        // 可取消的倒计时自动跳转
        <div className="flex items-center justify-between gap-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 px-4 py-3">
          <div className="min-w-0">
            <span className="text-sm font-medium text-amber-700 dark:text-amber-300 truncate block">
              {t('continuousLearning.nextLesson')}：{nextTitle}
            </span>
            <span className="text-xs text-amber-600/80 dark:text-amber-400/80">
              {t('continuousLearning.autoAdvanceCountdown', { seconds: countdown })}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setCancelled(true)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              {t('continuousLearning.cancel')}
            </button>
            <button
              onClick={goToNextLesson}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-colors"
            >
              {t('continuousLearning.enterNow')}
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ) : (
        // 手动进入下一节
        <button
          onClick={goToNextLesson}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 text-white text-sm font-bold hover:from-amber-600 hover:to-orange-600 transition-all shadow-sm"
        >
          {t('continuousLearning.enterNext')}：{nextTitle}
          <ArrowRight className="w-4 h-4" />
        </button>
      )}

      {/* 学习进度 */}
      <p className="text-center text-xs text-gray-400 dark:text-gray-500">
        {t('continuousLearning.progress', { current: currentIndex + 1, total })}
      </p>
    </div>
  );
}
