'use client';

/**
 * 导师声音切换器（课堂头部）。
 *
 * 预生成多音色架构：课堂生成时已为每个 speech action 预生成 4 种音色的音频，
 * 切换音色仅需更新 store 中的 ttsVoice 值，播放引擎会自动解析到对应音频。
 * 无需网络请求、无需重新生成、无需等待 —— 瞬时切换。
 */
import { useState } from 'react';
import { Volume2, ChevronDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import { cn } from '@/lib/utils';

/** MiniMax TTS 预生成音色列表（两女两男）。 */
const VOICES = TTS_PROVIDERS['minimax-tts'].voices;

export function MentorVoiceSwitcher() {
  const { t } = useI18n();

  const ttsVoice = useSettingsStore((s) => s.ttsVoice);
  const setTTSVoice = useSettingsStore((s) => s.setTTSVoice);

  const [popoverOpen, setPopoverOpen] = useState(false);

  const displayName =
    VOICES.find((v) => v.id === ttsVoice)?.name || VOICES[0]?.name || t('stage.noVoices');

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('stage.mentorVoice')}
          title={t('stage.mentorVoice')}
          className={cn(
            'shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-full backdrop-blur-md shadow-sm transition-colors',
            'bg-white/60 dark:bg-gray-800/60 border border-gray-100/50 dark:border-gray-700/50',
            'text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 cursor-pointer',
          )}
        >
          <Volume2 className="w-4 h-4" />
          <span className="text-xs font-medium max-w-[110px] truncate">{displayName}</span>
          <ChevronDown className="w-3 h-3 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-56 p-0">
        <div className="px-3 py-2 border-b border-border/50 text-xs font-medium text-muted-foreground">
          {t('stage.mentorVoice')}
        </div>
        <div className="p-1">
          {VOICES.map((voice) => {
            const isActive = ttsVoice === voice.id;
            return (
              <button
                key={voice.id}
                type="button"
                onClick={() => {
                  setTTSVoice(voice.id);
                  setPopoverOpen(false);
                }}
                className={cn(
                  'w-full text-left text-[13px] px-2 py-1.5 rounded-sm truncate transition-colors cursor-pointer',
                  isActive ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted',
                )}
              >
                {voice.name}
                <span className="ml-1.5 text-[11px] text-muted-foreground/60">
                  {voice.gender === 'female' ? '♀' : '♂'}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
