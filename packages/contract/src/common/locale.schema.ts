import { Static, Type } from '@sinclair/typebox';

export const supportedLocales = ['zh-CN', 'en-US'] as const;

export const LocaleSchema = Type.Union(
  supportedLocales.map((locale) => Type.Literal(locale)),
);

export type Locale = Static<typeof LocaleSchema>;
