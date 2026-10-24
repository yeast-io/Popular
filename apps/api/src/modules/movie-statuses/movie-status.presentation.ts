import type { Locale } from '@movie-hub/contract';

export function unavailableSavedMovieTitle(locale: Locale, tmdbId: number): string {
  return locale === 'zh-CN' ? `资料暂不可用 · TMDB ${tmdbId}` : `Information unavailable · TMDB ${tmdbId}`;
}
