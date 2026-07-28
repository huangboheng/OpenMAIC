'use client';

import { Clock, ArrowLeft, AlertTriangle } from 'lucide-react';

interface PreviewExpiredOverlayProps {
  /** 剩余秒数（用于展示倒计时） */
  remainingSeconds: number;
  /** 返回 Philochora 课程页的 URL（可选） */
  backUrl?: string;
}

/**
 * 试看超时阻断层
 *
 * 课堂内 10 分钟免费试看到期后，覆盖整个页面显示提示。
 * 引导用户返回 Philochora 课程页。
 */
export function PreviewExpiredOverlay({
  remainingSeconds,
  backUrl,
}: PreviewExpiredOverlayProps) {
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="max-w-md w-full mx-4 rounded-2xl border border-amber-500/20 bg-slate-900 p-8 text-center shadow-[0_24px_64px_rgba(0,0,0,0.5)]">
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-amber-500/10 flex items-center justify-center">
          <Clock className="w-8 h-8 text-amber-400" />
        </div>

        <h2 className="text-xl font-semibold text-white mb-2">免费试看已结束</h2>

        <p className="text-sm text-slate-400 mb-6">
          10 分钟免费体验时间已到。
          <br />
          返回课程页面后可以重新进入继续试看。
        </p>

        {remainingSeconds > 0 && (
          <div className="mb-6 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <span className="text-sm text-amber-300">
              下次试看可于 {minutes}:{String(seconds).padStart(2, '0')} 后开始
            </span>
          </div>
        )}

        <div className="flex flex-col gap-3">
          {backUrl ? (
            <a
              href={backUrl}
              className="inline-flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-amber-500/20 border border-amber-500/30 text-amber-300 font-medium hover:bg-amber-500/30 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              返回课程页
            </a>
          ) : (
            <button
              onClick={() => window.close()}
              className="inline-flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-amber-500/20 border border-amber-500/30 text-amber-300 font-medium hover:bg-amber-500/30 transition-colors"
            >
              关闭页面
            </button>
          )}
        </div>

        <p className="text-xs text-slate-500 mt-4">
          重新打开课堂即可开始新一轮 10 分钟试看
        </p>
      </div>
    </div>
  );
}
