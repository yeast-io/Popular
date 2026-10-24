import type { Locale, MovieTrailer } from '@movie-hub/contract';
import type { TmdbTvVideo } from './tmdb-tv.schema.js';

export function selectTvTrailer(videos: TmdbTvVideo[], locale: Locale): MovieTrailer | undefined {
  const [language, region] = locale.split('-');
  const score = (video: TmdbTvVideo) => (video.iso_639_1 === language ? 4 : 0) + (video.iso_3166_1 === region ? 2 : 0) + (video.official ? 1 : 0);
  const selected = [...videos].sort((left, right) => score(right) - score(left)
    || Date.parse(right.published_at ?? '1970-01-01') - Date.parse(left.published_at ?? '1970-01-01'))[0];
  if (!selected) return undefined;
  return {
    tmdbVideoId: selected.id, provider: 'youtube', providerVideoId: selected.key, name: selected.name,
    official: selected.official,
    ...(selected.iso_639_1 ? { language: selected.iso_639_1 } : {}),
    ...(selected.iso_3166_1 ? { region: selected.iso_3166_1 } : {}),
    ...(selected.published_at ? { publishedAt: selected.published_at } : {}),
  };
}
