import { selectTvTrailer } from './tmdb-tv-trailer.domain.js';
import { definedFields } from '../../modules/tv-shows/tv-show.domain.js';
import type { Locale } from '@movie-hub/contract';
import type { ExternalRequestContext } from '../../modules/external-usage/external-usage.types.js';
import type { TvShowProvider, TvShowRecord } from '../../modules/tv-shows/tv-show.types.js';
import type { TvSeasonProvider, TvSeasonRecord } from '../../modules/tv-shows/tv-season.types.js';
import type { TmdbHttpClient } from './tmdb-http.client.js';
import { TmdbTvDetailSchema, TmdbTvTrendingSchema, TmdbTvSeasonSchema } from './tmdb-tv.schema.js';
import type { TmdbTvSummary, TmdbTvSeasonSummary } from './tmdb-tv.schema.js';

export class TmdbTvClient implements TvShowProvider, TvSeasonProvider {
  constructor(private readonly http: TmdbHttpClient, private readonly baseUrl = 'https://api.themoviedb.org/3') {}

  async fetchTrending(page: number, locale: Locale, context: ExternalRequestContext) {
    const payload = TmdbTvTrendingSchema.parse(await this.get('/trending/tv/week', locale, 'tv.trending', context, page));
    if (payload.page !== page)
      throw new Error('TMDB TV page mismatch');
    const ids = payload.results.map((item) => item.id);
    if (new Set(ids).size !== ids.length)
      throw new Error('TMDB TV page contains duplicate IDs');
    return { items: payload.results.map(mapShow), page, totalPages: payload.total_pages, totalResults: payload.total_results };
  }

  async search(query: string, page: number, locale: Locale, context: ExternalRequestContext) {
    const payload = TmdbTvTrendingSchema.parse(await this.get('/search/tv', locale, 'tv.search', context, page, query));
    if (payload.page !== page) throw new Error('TMDB TV search page mismatch');
    const seen = new Set<number>();
    const items = payload.results.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }).map(mapShow);
    return { items, page, totalPages: payload.total_pages, totalResults: payload.total_results };
  }

  async fetchDetail(tmdbId: number, locale: Locale, context: ExternalRequestContext): Promise<TvShowRecord> {
    const payload = TmdbTvDetailSchema.parse(await this.get(`/tv/${tmdbId}`, locale, 'tv.details', context));
    if (payload.id !== tmdbId)
      throw new Error('TMDB TV identity mismatch');
    const seasons = payload.seasons.map((season) => mapSeason(season, tmdbId));
    if (new Set(seasons.map((season) => season.seasonNumber)).size !== seasons.length)
      throw new Error('TMDB duplicate season numbers');
    return definedFields({
      ...mapShow(payload), tagline: payload.tagline, trailer: selectTvTrailer(payload.videos?.results ?? [], locale), lastAirDate: payload.last_air_date, status: payload.status,
      inProduction: payload.in_production, numberOfSeasons: payload.number_of_seasons ?? undefined,
      numberOfEpisodes: payload.number_of_episodes ?? undefined,
      genreIds: payload.genres.map((g) => g.id), genres: payload.genres.map((g) => ({ tmdbId: g.id, name: g.name })), seasons,
    });
  }

  async fetchSeason(tmdbId: number, seasonNumber: number, locale: Locale, context: ExternalRequestContext): Promise<TvSeasonRecord> {
    const payload = TmdbTvSeasonSchema.parse(await this.get(`/tv/${tmdbId}/season/${seasonNumber}`, locale, 'tv.season', context));
    if (payload.season_number !== seasonNumber)
      throw new Error('TMDB TV season mismatch');
    const episodes = payload.episodes.map((e) => {
      if (e.season_number !== seasonNumber || (e.show_id !== undefined && e.show_id !== tmdbId))
        throw new Error('TMDB episode identity mismatch');
      return definedFields({
        tmdbId: e.id, tvShowTmdbId: tmdbId, seasonNumber, episodeNumber: e.episode_number, name: e.name,
        overview: e.overview, stillPath: e.still_path, episodeType: e.episode_type, airDate: e.air_date,
        runtimeMinutes: e.runtime ?? undefined, voteAverage: e.vote_average ?? undefined, voteCount: e.vote_count ?? undefined,
      });
    });
    if (new Set(episodes.map((e) => e.episodeNumber)).size !== episodes.length)
      throw new Error('TMDB duplicate episode numbers');
    return { ...mapSeason(payload, tmdbId), episodeCount: episodes.length, episodes };
  }

  private async get(path: string, locale: Locale, operation: string, context: ExternalRequestContext, page?: number, query?: string): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('language', locale);
    if (operation === 'tv.details') {
      url.searchParams.set('append_to_response', 'videos');
      url.searchParams.set('include_video_language', [...new Set([locale.split('-')[0]!, 'en', 'null'])].join(','));
    }
    if (page)
      url.searchParams.set('page', String(page));
    if (query !== undefined) {
      url.searchParams.set('query', query);
      url.searchParams.set('include_adult', 'false');
    }
    const response = await this.http.request(url, operation, context);
    return response.json();
  }
}
function mapShow(v: TmdbTvSummary): TvShowRecord {
  return definedFields({
    mediaType: 'tv', tmdbId: v.id, name: v.name, originalName: v.original_name, originalLanguage: v.original_language,
    overview: v.overview, firstAirDate: v.first_air_date, posterPath: v.poster_path, backdropPath: v.backdrop_path,
    genreIds: v.genre_ids ?? [], voteAverage: v.vote_average ?? undefined, voteCount: v.vote_count ?? undefined,
  });
}
function mapSeason(v: TmdbTvSeasonSummary, tvShowTmdbId: number): TvSeasonRecord {
  return definedFields({
    tmdbId: v.id, tvShowTmdbId, seasonNumber: v.season_number, name: v.name, overview: v.overview,
    posterPath: v.poster_path, airDate: v.air_date, episodeCount: v.episode_count ?? undefined, voteAverage: v.vote_average ?? undefined,
  });
}
