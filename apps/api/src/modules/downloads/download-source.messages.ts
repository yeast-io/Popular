import type { Locale } from '@movie-hub/contract';

export const downloadSourceMessages: Record<Locale, { mteamNotConfigured: string }> = {
  'en-US': { mteamNotConfigured: 'Configure M-Team before downloading' },
  'zh-CN': { mteamNotConfigured: '请先配置 M-Team 再下载' },
};
