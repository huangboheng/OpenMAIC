/**
 * Shared constants for agent profile generation.
 *
 * Used by both the client-side agent-profiles API route and the
 * server-side classroom-generation pipeline to keep colors / avatars in sync.
 */
import { withBasePath } from '@/lib/utils/base-path';

/** Color palette cycled for generated agents */
export const AGENT_COLOR_PALETTE = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#06b6d4',
  '#8b5cf6',
  '#f97316',
  '#14b8a6',
  '#e11d48',
  '#6366f1',
  '#84cc16',
  '#a855f7',
] as const;

/**
 * Default avatar paths cycled for generated agents.
 *
 * Every entry MUST correspond to a file that exists under `public/avatars/`.
 * 使用 withBasePath 包裹以兼容 /openmaic 子路径部署。
 */
export const AGENT_DEFAULT_AVATARS = [
  withBasePath('/avatars/teacher.png'),
  withBasePath('/avatars/assist.png'),
  withBasePath('/avatars/curious.png'),
  withBasePath('/avatars/thinker.png'),
  withBasePath('/avatars/note-taker.png'),
  withBasePath('/avatars/teacher-2.png'),
  withBasePath('/avatars/assist-2.png'),
  withBasePath('/avatars/curious-2.png'),
  withBasePath('/avatars/thinker-2.png'),
  withBasePath('/avatars/note-taker-2.png'),
] as const;
