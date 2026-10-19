import type zhCN from './locales/zh-CN';

export type TranslationKey = keyof typeof zhCN;

export type TranslationParams = Readonly<Record<string, string | number>>;
