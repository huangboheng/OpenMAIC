'use client';

/**
 * 导师声音切换器（课堂头部）。
 *
 * 托管部署下设置面板被 isSettingsEnabled() 门控隐藏，课堂内没有声音配置入口；
 * 本组件独立于该门控，始终挂载在课堂头部（HeaderControls），让用户可以为
 * AI 导师选择朗读音色。
 *
 * 由于讲课音频是预生成缓存的，切换音色必须重新合成全部讲课音频才能生效。
 * 因此交互为：选择音色 → 弹确认框明确告知耗时与影响 → 确认后启用 TTS、
 * 写入音色并触发批量重生成（进度可见、防重复触发、完成/失败均有反馈）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Volume2, Loader2, ChevronDown, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { useVoiceRegenStore } from '@/lib/store/voice-regen';
import { regenerateAllSpeech } from '@/lib/audio/regenerate-all-speech';
import { getSelectableProvidersWithVoices } from '@/lib/audio/voice-resolver';
import { cn } from '@/lib/utils';
import type { TTSProviderId } from '@/lib/audio/types';

/** 待确认切换的目标音色。 */
interface PendingVoice {
  providerId: TTSProviderId;
  voiceId: string;
  modelId?: string;
}

export function MentorVoiceSwitcher() {
  const { t } = useI18n();

  const ttsProviderId = useSettingsStore((s) => s.ttsProviderId);
  const ttsVoice = useSettingsStore((s) => s.ttsVoice);
  const ttsProvidersConfig = useSettingsStore((s) => s.ttsProvidersConfig);
  const setTTSProvider = useSettingsStore((s) => s.setTTSProvider);
  const setTTSVoice = useSettingsStore((s) => s.setTTSVoice);
  const setTTSProviderConfig = useSettingsStore((s) => s.setTTSProviderConfig);
  const setTTSEnabled = useSettingsStore((s) => s.setTTSEnabled);

  const running = useVoiceRegenStore((s) => s.running);
  const done = useVoiceRegenStore((s) => s.done);
  const total = useVoiceRegenStore((s) => s.total);
  const regenError = useVoiceRegenStore((s) => s.error);
  const clearError = useVoiceRegenStore((s) => s.clearError);

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [pendingVoice, setPendingVoice] = useState<PendingVoice | null>(null);
  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([]);

  // 浏览器原生音色为动态列表，挂载后加载（与 AgentBar 选择器同源）。
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const load = () => setBrowserVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener?.('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', load);
  }, []);

  const availableProviders = getSelectableProvidersWithVoices(
    ttsProvidersConfig,
    [],
    browserVoices,
  );

  // 当前音色展示名（在选择器可用音色中查找，找不到则回退原始 id）。
  const displayName = (() => {
    for (const p of availableProviders) {
      if (p.providerId === ttsProviderId) {
        const v = p.voices.find((voice) => voice.id === ttsVoice);
        if (v) return v.name;
      }
    }
    return ttsVoice || t('stage.voiceDefault');
  })();

  /** 应用音色并触发全部讲课音频重生成，结束后给出成功/失败反馈。 */
  const applyVoiceAndRegenerate = useCallback(
    async (target: PendingVoice) => {
      // 先设 provider 再设 voice（provider 变化会重置 voice），最后启用 TTS。
      setTTSProvider(target.providerId);
      setTTSVoice(target.voiceId);
      if (target.modelId) {
        setTTSProviderConfig(target.providerId, { modelId: target.modelId });
      }
      setTTSEnabled(true);

      const failed = await regenerateAllSpeech();
      if (failed > 0) {
        toast.error(t('stage.voicesFailed', { count: failed }));
      } else {
        toast.success(t('stage.voicesUpdated'));
      }
    },
    [setTTSProvider, setTTSVoice, setTTSProviderConfig, setTTSEnabled, t],
  );

  /** 重试：按当前音色重新合成全部讲课音频。 */
  const handleRetry = useCallback(() => {
    clearError();
    void regenerateAllSpeech().then((failed) => {
      if (failed > 0) toast.error(t('stage.voicesFailed', { count: failed }));
      else toast.success(t('stage.voicesUpdated'));
    });
  }, [clearError, t]);

  return (
    <>
      <Popover open={popoverOpen && !running} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={running}
            aria-label={t('stage.mentorVoice')}
            title={t('stage.mentorVoice')}
            className={cn(
              'shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-full backdrop-blur-md shadow-sm transition-colors',
              'bg-white/60 dark:bg-gray-800/60 border border-gray-100/50 dark:border-gray-700/50',
              running
                ? 'cursor-not-allowed opacity-80 text-gray-500 dark:text-gray-400'
                : 'text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 cursor-pointer',
            )}
          >
            {running ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <span className="text-xs font-medium whitespace-nowrap">
                  {t('stage.regeneratingVoices', { done, total })}
                </span>
              </>
            ) : (
              <>
                <Volume2 className="w-4 h-4" />
                <span className="text-xs font-medium max-w-[110px] truncate">{displayName}</span>
                <ChevronDown className="w-3 h-3 opacity-50" />
              </>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={8} className="w-72 p-0">
          <div className="px-3 py-2 border-b border-border/50 text-xs font-medium text-muted-foreground">
            {t('stage.mentorVoice')}
          </div>
          <div className="max-h-80 overflow-y-auto p-1">
            {availableProviders.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground/60">
                {t('stage.noVoices')}
              </div>
            )}
            {availableProviders.map((provider) =>
              provider.modelGroups.map((group) => (
                <div key={`${provider.providerId}::${group.modelId}`}>
                  <div className="sticky top-0 bg-popover px-2 py-1 text-[11px] font-medium text-muted-foreground/60">
                    {group.modelId
                      ? `${provider.providerName} · ${group.modelName}`
                      : provider.providerName}
                  </div>
                  {group.voices.map((voice) => {
                    const isActive = ttsProviderId === provider.providerId && ttsVoice === voice.id;
                    return (
                      <button
                        key={`${provider.providerId}::${voice.id}`}
                        type="button"
                        onClick={() => {
                          setPopoverOpen(false);
                          setPendingVoice({
                            providerId: provider.providerId,
                            voiceId: voice.id,
                            modelId: group.modelId || undefined,
                          });
                        }}
                        className={cn(
                          'w-full text-left text-[13px] px-2 py-1.5 rounded-sm truncate transition-colors cursor-pointer',
                          isActive ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted',
                        )}
                      >
                        {voice.name}
                      </button>
                    );
                  })}
                </div>
              )),
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* 重生成失败后的重试入口 */}
      {regenError && !running && (
        <button
          type="button"
          onClick={handleRetry}
          aria-label={t('stage.voiceRetry')}
          title={regenError}
          className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full backdrop-blur-md shadow-sm bg-white/60 dark:bg-gray-800/60 border border-red-200/60 dark:border-red-900/60 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      )}

      {/* 切换前确认：明确告知将重新生成全部讲课音频及其耗时影响 */}
      <AlertDialog open={pendingVoice !== null} onOpenChange={(open) => !open && setPendingVoice(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('stage.voiceSwitchConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('stage.voiceSwitchConfirmDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingVoice(null)}>
              {t('stage.voiceCancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingVoice) void applyVoiceAndRegenerate(pendingVoice);
                setPendingVoice(null);
              }}
            >
              {t('stage.voiceSwitchConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
