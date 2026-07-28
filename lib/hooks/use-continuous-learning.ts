'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * 连续学习（Continuous Learning）
 *
 * 当 OpenMAIC 课堂经由 Philochora 课程详情页嵌入时，iframe URL 会携带：
 *   - chapters: base64(encodeURIComponent(JSON)) 编码的章节序列 [{ n, title, cid }]
 *   - chapterIndex: 当前章节在序列中的索引
 *   - philochoraUserId: Philochora 用户标识（用于进度回传）
 *
 * 本 Hook 解析这些参数，提供“下一节”导航能力与连续学习开关。
 * 连续学习开关为用户偏好（localStorage），默认关闭，不暴露任何系统配置。
 */

export interface ChapterSeqItem {
  /** chapterNumber */
  n: number;
  title: string;
  /** 该章节对应的 OpenMAIC classroom id */
  cid: string;
}

const STORAGE_KEY = 'openmaic.continuousLearning';

function decodeChapterSeq(raw: string | null): ChapterSeqItem[] {
  if (!raw) return [];
  try {
    const json = decodeURIComponent(atob(raw));
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is ChapterSeqItem =>
        !!x && typeof (x as ChapterSeqItem).cid === 'string' && typeof (x as ChapterSeqItem).n === 'number',
    );
  } catch {
    return [];
  }
}

interface UrlParams {
  chaptersRaw: string | null;
  chapterIndex: number;
  philochoraUserId: string | null;
  courseSlug: string | null;
  resumeFrom: string | null;
}

function readParams(): UrlParams {
  if (typeof window === 'undefined') {
    return { chaptersRaw: null, chapterIndex: 0, philochoraUserId: null, courseSlug: null, resumeFrom: null };
  }
  const sp = new URLSearchParams(window.location.search);
  const idxRaw = parseInt(sp.get('chapterIndex') ?? '0', 10);
  return {
    chaptersRaw: sp.get('chapters'),
    chapterIndex: Number.isNaN(idxRaw) ? 0 : idxRaw,
    philochoraUserId: sp.get('philochoraUserId'),
    courseSlug: sp.get('courseSlug'),
    resumeFrom: sp.get('resumeFrom'),
  };
}

export interface ContinuousLearning {
  /** 是否携带有效章节序列（即是否处于连续学习上下文） */
  hasSequence: boolean;
  currentIndex: number;
  total: number;
  currentChapter: ChapterSeqItem | undefined;
  nextChapter: ChapterSeqItem | undefined;
  hasNext: boolean;
  isLast: boolean;
  continuous: boolean;
  toggleContinuous: (next: boolean) => void;
  goToChapter: (index: number) => void;
  goToNextLesson: () => void;
  /** Philochora 用户 ID（用于进度回传） */
  philochoraUserId: string | null;
  /** 课程 slug（用于进度回传识别课程） */
  courseSlug: string | null;
  /** 是否从快照恢复（异常退出后恢复学习位置） */
  resumeFrom: string | null;
}

export function useContinuousLearning(): ContinuousLearning {
  // 课堂通过 window.location.href 整页导航，每次加载时参数即为最新，读取一次即可
  const { chaptersRaw, chapterIndex, philochoraUserId, courseSlug, resumeFrom } = useMemo(readParams, []);
  const chapters = useMemo(() => decodeChapterSeq(chaptersRaw), [chaptersRaw]);

  const total = chapters.length;
  const currentIndex = chapterIndex;
  const currentChapter = chapters[currentIndex];
  const nextChapter = chapters[currentIndex + 1];
  const hasNext = !!nextChapter;
  const isLast = total > 0 && currentIndex >= total - 1;
  const hasSequence = total > 0;

  // 连续学习开关（用户偏好，默认关闭）
  const [continuous, setContinuous] = useState(false);
  useEffect(() => {
    try {
      setContinuous(localStorage.getItem(STORAGE_KEY) === 'true');
    } catch {
      /* localStorage 不可用 */
    }
  }, []);

  const toggleContinuous = useCallback((next: boolean) => {
    setContinuous(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      /* ignore */
    }
  }, []);

  // 导航到指定章节：在当前 iframe 内跳转，保留序列与用户标识。
  // 依据当前 pathname 推导基础路径，兼容 /openmaic/classroom/ 代理与 /classroom/ 直连两种形态。
  const goToChapter = useCallback(
    (index: number) => {
      const target = chapters[index];
      if (!target) return;
      const path = window.location.pathname;
      const basePath = path.substring(0, path.lastIndexOf('/') + 1);
      const params = new URLSearchParams();
      if (philochoraUserId) params.set('philochoraUserId', philochoraUserId);
      if (courseSlug) params.set('courseSlug', courseSlug);
      if (chaptersRaw) params.set('chapters', chaptersRaw);
      if (resumeFrom) params.set('resumeFrom', resumeFrom);
      params.set('chapterIndex', String(index));
      window.location.href = `${basePath}${target.cid}?${params.toString()}`;
    },
    [chapters, chaptersRaw, philochoraUserId, courseSlug, resumeFrom],
  );

  const goToNextLesson = useCallback(() => {
    if (hasNext) goToChapter(currentIndex + 1);
  }, [hasNext, goToChapter, currentIndex]);

  // 加载时通知父页面（Philochora 课程详情页）当前章节，用于同步章节高亮
  useEffect(() => {
    if (!hasSequence) return;
    try {
      window.parent.postMessage({ type: 'openmaic-chapter', chapterIndex: currentIndex }, '*');
    } catch {
      /* ignore */
    }
  }, [hasSequence, currentIndex]);

  return {
    hasSequence,
    currentIndex,
    total,
    currentChapter,
    nextChapter,
    hasNext,
    isLast,
    continuous,
    toggleContinuous,
    goToChapter,
    goToNextLesson,
    philochoraUserId,
    courseSlug,
    resumeFrom,
  };
}
