import type { ResolvedLocalization } from './movie-store.types.js';
import type { Locale } from '@movie-hub/contract';
import type { Model } from 'mongoose';
import type { MovieCreditDocument } from './movie-credit.schema.js';
import type { MovieLocalizationDocument } from './movie-localization.schema.js';
import type { MovieResultSetDocument } from './movie-result-set.schema.js';
import type { MovieDocument } from './movie.schema.js';
import type { PersonDocument } from './person.schema.js';
import type { TrendingStateDocument } from '../sync/trending-state.schema.js';
import type { MovieCatalogStore, MovieDetailRecord, MovieRecord, TrendingPageRecord, TrendingSnapshotRecord, TrendingStore } from '../../../modules/movies/movie.types.js';

export class MongoTrendingStore implements TrendingStore, MovieCatalogStore {
  constructor(
    private readonly movies: Model<MovieDocument>,
    private readonly localizations: Model<MovieLocalizationDocument>,
    private readonly resultSets: Model<MovieResultSetDocument>,
    private readonly people?: Model<PersonDocument>,
    private readonly credits?: Model<MovieCreditDocument>,
    private readonly trendingStates?: Model<TrendingStateDocument>
  ) {}

  async publishSnapshot(record: TrendingSnapshotRecord, locale: Locale): Promise<void> {
    const states = this.requireTrendingStates();
    await this.upsertMovies(
      record.pages.flatMap(({ movies }) => movies),
      record.fetchedAt,
      locale,
    );
    await this.resultSets.bulkWrite(
      record.pages.map((page) => {
        return {
          updateOne: {
            filter: { key: trendingGenerationKey(locale, record.generation, page.page) },
            update: {
              $set: {
                type: 'trending',
                params: {
                  mediaType: 'movie',
                  window: 'week',
                  language: locale,
                  sourcePage: record.sourcePage,
                  pageSize: record.pageSize,
                },
                page: page.page,
                tmdbIds: page.movies.map(({ tmdbId }) => tmdbId),
                totalPages: page.totalPages,
                totalResults: page.totalResults,
                fetchedAt: record.fetchedAt,
                generation: record.generation,
              },
            },
            upsert: true,
          },
        };
      }),
      { ordered: true },
    );
    await states.updateOne(
      { locale },
      { $set: { activeGeneration: record.generation, publishedAt: record.fetchedAt } },
      { upsert: true },
    );
    await this.resultSets.updateMany(
      {
        type: 'trending',
        generation: { $ne: record.generation },
        'params.language': locale,
        deleteAt: { $exists: false },
      },
      { $set: { deleteAt: new Date(record.fetchedAt.getTime() + 24 * 60 * 60 * 1_000) } },
    );
  }

  async appendSnapshotPage(
    record: TrendingPageRecord,
    locale: Locale,
    generation: string,
    sourcePage: number,
    pageSize: number,
  ): Promise<void> {
    this.requireTrendingStates();
    await this.upsertMovies(record.movies, record.fetchedAt, locale);
    await this.resultSets.updateOne(
      { key: trendingGenerationKey(locale, generation, record.page) },
      {
        $set: {
          type: 'trending',
          params: { mediaType: 'movie', window: 'week', language: locale, sourcePage, pageSize },
          page: record.page,
          tmdbIds: record.movies.map(({ tmdbId }) => tmdbId),
          totalPages: record.totalPages,
          totalResults: record.totalResults,
          fetchedAt: record.fetchedAt,
          generation,
        },
      },
      { upsert: true },
    );
  }

  async publishSearch(query: string, record: TrendingPageRecord, locale: Locale): Promise<void> {
    await this.upsertMovies(record.movies, record.fetchedAt, locale);
    await this.resultSets.updateOne(
      { key: searchKey(query, locale, record.page) },
      {
        $set: {
          type: 'search',
          params: { query, language: locale },
          page: record.page,
          tmdbIds: record.movies.map(({ tmdbId }) => tmdbId),
          totalPages: record.totalPages,
          totalResults: record.totalResults,
          fetchedAt: record.fetchedAt,
        },
      },
      { upsert: true },
    );
  }

  async readSearch(query: string, page: number, locale: Locale): Promise<TrendingPageRecord | null> {
    const resultSet = await this.resultSets
      .findOne({ key: searchKey(query, locale, page) })
      .lean()
      .exec();
    if (!resultSet) return null;
    return {
      movies: await this.readMovies(resultSet.tmdbIds, locale),
      page: resultSet.page,
      totalPages: resultSet.totalPages,
      totalResults: resultSet.totalResults,
      fetchedAt: resultSet.fetchedAt,
      expectedMovieCount: resultSet.tmdbIds.length,
    };
  }

  async upsertMovies(records: MovieRecord[], syncedAt: Date, locale: Locale): Promise<void> {
    if (records.length === 0) return;
    await this.movies.bulkWrite(
      records.map((movie) => {
        return {
          updateOne: {
            filter: { tmdbId: movie.tmdbId },
            update: { $set: toBaseMovieUpdate(movie), $setOnInsert: { tmdbId: movie.tmdbId } },
            upsert: true,
          },
        };
      }),
      { ordered: false },
    );
    await this.localizations.bulkWrite(
      records.map((movie) => {
        return {
          updateOne: {
            filter: { movieTmdbId: movie.tmdbId, locale },
            update: {
              $set: toSummaryLocalizationUpdate(movie, syncedAt),
              $setOnInsert: { movieTmdbId: movie.tmdbId, locale },
            },
            upsert: true,
          },
        };
      }),
      { ordered: false },
    );
  }

  async readMovies(tmdbIds: number[], locale: Locale): Promise<MovieRecord[]> {
    if (tmdbIds.length === 0) return [];
    const [movies, localizations] = await Promise.all([
      this.movies
        .find({ tmdbId: { $in: tmdbIds } })
        .lean()
        .exec(),
      this.localizations
        .find({
          movieTmdbId: { $in: tmdbIds },
          locale,
        })
        .lean()
        .exec(),
    ]);
    const movieById = new Map(movies.map((movie) => [movie.tmdbId, movie]));
    const localizationByKey = new Map(
      localizations.map((row) => {
        return [`${row.movieTmdbId}:${row.locale}`, row];
      }),
    );
    return tmdbIds.flatMap((tmdbId) => {
      const movie = movieById.get(tmdbId);
      if (!movie) return [];
      const requested = localizationByKey.get(`${tmdbId}:${locale}`);
      const localized = resolveLocalization(requested, movie.originalTitle ?? undefined);
      return localized ? [fromDocuments(movie, localized)] : [];
    });
  }

  async hasMovie(tmdbId: number): Promise<boolean> {
    return (await this.movies.exists({ tmdbId })) !== null;
  }

  async readMovieIdentity(tmdbId: number, locale: Locale): Promise<{ title: string; imdbId?: string } | null> {
    const [movie, localization] = await Promise.all([
      this.movies.findOne({ tmdbId }).select({ imdbId: 1, originalTitle: 1 }).lean().exec(),
      this.localizations.findOne({ movieTmdbId: tmdbId, locale }).select({ title: 1 }).lean().exec(),
    ]);
    if (!movie) return null;
    const title = localization?.title || movie.originalTitle;
    if (!title) return null;
    return { title, ...(movie.imdbId ? { imdbId: movie.imdbId } : {}) };
  }

  async writeMovieDetail(movie: MovieDetailRecord, syncedAt: Date, locale: Locale): Promise<void> {
    if (!this.people || !this.credits) throw new Error('Movie detail persistence is not configured');
    const allCredits = [...movie.cast, ...movie.directors];
    const uniquePeople = [
      ...new Map(
        allCredits.map(({ person }) => {
          return [person.tmdbId, person];
        }),
      ).values(),
    ];
    if (uniquePeople.length > 0) {
      await this.people.bulkWrite(
        uniquePeople.map((person) => {
          return {
            updateOne: {
              filter: { tmdbId: person.tmdbId, locale },
              update: { $set: { ...person, locale, syncedAt } },
              upsert: true,
            },
          };
        }),
        { ordered: false },
      );
    }

    const syncVersion = crypto.randomUUID();
    if (allCredits.length > 0) {
      await this.credits.insertMany(
        allCredits.map((credit) => {
          return {
            movieTmdbId: movie.tmdbId,
            locale,
            personTmdbId: credit.person.tmdbId,
            tmdbCreditId: credit.creditId,
            creditType: credit.type,
            ...(credit.character ? { character: credit.character } : {}),
            ...(credit.order !== undefined ? { castOrder: credit.order } : {}),
            syncVersion,
          };
        }),
        { ordered: false },
      );
    }

    await this.movies.updateOne(
      { tmdbId: movie.tmdbId },
      {
        $set: {
          ...toBaseMovieUpdate(movie),
          ...(movie.imdbId ? { imdbId: movie.imdbId } : {}),
          ...(typeof movie.runtimeMinutes === 'number' ? { runtimeMinutes: movie.runtimeMinutes } : {}),
        },
        $setOnInsert: { tmdbId: movie.tmdbId },
      },
      { upsert: true },
    );
    const localizationSet = {
      ...toSummaryLocalizationUpdate(movie, syncedAt),
      ...(movie.tagline ? { tagline: movie.tagline } : {}),
      genres: movie.genres,
      detailSyncedAt: syncedAt,
      trailerSyncedAt: syncedAt,
      activeCreditVersion: syncVersion,
      ...(movie.trailer ? { trailer: movie.trailer } : {}),
    };
    await this.localizations.updateOne(
      { movieTmdbId: movie.tmdbId, locale },
      {
        $set: localizationSet,
        ...(!movie.trailer ? { $unset: { trailer: 1 } } : {}),
        $setOnInsert: { movieTmdbId: movie.tmdbId, locale },
      },
      { upsert: true },
    );
    await this.credits.deleteMany({ movieTmdbId: movie.tmdbId, locale, syncVersion: { $ne: syncVersion } });
  }

  async readMovieDetail(tmdbId: number, locale: Locale): Promise<MovieDetailRecord | null> {
    if (!this.people || !this.credits) throw new Error('Movie detail persistence is not configured');
    const [movie, localization] = await Promise.all([
      this.movies.findOne({ tmdbId }).lean().exec(),
      this.localizations.findOne({ movieTmdbId: tmdbId, locale }).lean().exec(),
    ]);
    if (!movie) return null;
    const detailSource = localization?.detailSyncedAt && localization.activeCreditVersion ? localization : undefined;
    if (!detailSource) return null;
    const localized = resolveLocalization(localization, movie.originalTitle ?? undefined);
    if (!localized) return null;

    const credits = await this.credits
      .find({
        movieTmdbId: tmdbId,
        locale: detailSource.locale,
        syncVersion: detailSource.activeCreditVersion,
      })
      .sort({ creditType: 1, castOrder: 1 })
      .lean()
      .exec();
    const people = await this.people
      .find({
        tmdbId: { $in: credits.map(({ personTmdbId }) => personTmdbId) },
        locale: detailSource.locale,
      })
      .lean()
      .exec();
    const peopleById = new Map(people.map((person) => [person.tmdbId, person]));
    const mappedCredits = credits.flatMap((credit) => {
      const person = peopleById.get(credit.personTmdbId);
      if (!person) return [];
      return [
        {
          person: {
            tmdbId: person.tmdbId,
            name: person.name,
            ...(person.originalName ? { originalName: person.originalName } : {}),
            ...(person.profilePath ? { profilePath: person.profilePath } : {}),
          },
          creditId: credit.tmdbCreditId,
          type: credit.creditType,
          ...(credit.character ? { character: credit.character } : {}),
          ...(typeof credit.castOrder === 'number' ? { order: credit.castOrder } : {}),
        },
      ];
    });
    return {
      ...fromDocuments(movie, localized),
      localizationLocale: detailSource.locale as Locale,
      ...(movie.imdbId ? { imdbId: movie.imdbId } : {}),
      ...(localized.tagline ? { tagline: localized.tagline } : {}),
      ...(typeof movie.runtimeMinutes === 'number' ? { runtimeMinutes: movie.runtimeMinutes } : {}),
      ...(localized.trailer ? { trailer: localized.trailer } : {}),
      ...(localized.trailerSyncedAt ? { trailerSyncedAt: localized.trailerSyncedAt } : {}),
      genres: localized.genres ?? [],
      cast: mappedCredits.filter((credit) => credit.type === 'cast'),
      directors: mappedCredits.filter((credit) => credit.type === 'director'),
      detailSyncedAt: detailSource.detailSyncedAt!,
    };
  }

  async readPage(page: number, locale: Locale, generation?: string) {
    const resolvedGeneration = generation ?? (await this.readActiveGeneration(locale));
    if (!resolvedGeneration) return null;
    const resultSet = await this.resultSets
      .findOne({
        key: trendingGenerationKey(locale, resolvedGeneration, page),
      })
      .lean()
      .exec();
    if (!resultSet) return null;
    const movies = await this.readMovies(resultSet.tmdbIds, locale);
    return {
      movies,
      page: resultSet.page,
      totalPages: resultSet.totalPages,
      totalResults: resultSet.totalResults,
      fetchedAt: resultSet.fetchedAt,
      generation: resolvedGeneration,
    };
  }

  async readSnapshot(locale: Locale, generation: string): Promise<TrendingSnapshotRecord | null> {
    this.requireTrendingStates();
    const resultSets = await this.resultSets
      .find({
        type: 'trending',
        generation,
        'params.language': locale,
      })
      .sort({ page: 1 })
      .lean()
      .exec();
    if (resultSets.length === 0) return null;
    const pages = await Promise.all(
      resultSets.map(async (resultSet) => {
        return {
          movies: await this.readMovies(resultSet.tmdbIds, locale),
          page: resultSet.page,
          totalPages: resultSet.totalPages,
          totalResults: resultSet.totalResults,
          fetchedAt: resultSet.fetchedAt,
        };
      }),
    );
    const params = resultSets.at(-1)?.params as { sourcePage?: unknown; pageSize?: unknown } | undefined;
    const sourcePage = typeof params?.sourcePage === 'number' ? params.sourcePage : pages.length;
    const pageSize =
      typeof params?.pageSize === 'number' ? params.pageSize : Math.max(1, pages[0]?.movies.length ?? 20);
    return { generation, pages, sourcePage, pageSize, fetchedAt: pages[0]!.fetchedAt };
  }

  private async readActiveGeneration(locale: Locale): Promise<string | null> {
    const state = await this.requireTrendingStates().findOne({ locale }).select({ activeGeneration: 1 }).lean().exec();
    return state?.activeGeneration ?? null;
  }

  private requireTrendingStates(): Model<TrendingStateDocument> {
    if (!this.trendingStates) throw new Error('Trending snapshot state persistence is not configured');
    return this.trendingStates;
  }
}

export function trendingKey(locale: Locale, page: number): string {
  return `trending:movie:week:${locale}:${page}`;
}

export function trendingGenerationKey(locale: Locale, generation: string, page: number): string {
  return `trending:movie:week:${locale}:generation:${generation}:page:${page}`;
}

export function searchKey(query: string, locale: Locale, page: number): string {
  const normalized = query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase(locale);
  return `search:movie:${locale}:${encodeURIComponent(normalized)}:${page}`;
}

function toBaseMovieUpdate(movie: MovieRecord): Record<string, unknown> {
  const update: Record<string, unknown> = { genreIds: movie.genreIds };
  for (const key of ['originalTitle', 'originalLanguage', 'releaseDate', 'voteAverage', 'voteCount'] as const) {
    if (movie[key] !== undefined) update[key] = key === 'releaseDate' ? new Date(movie[key]) : movie[key];
  }
  return update;
}

function toSummaryLocalizationUpdate(movie: MovieRecord, syncedAt: Date): Record<string, unknown> {
  const update: Record<string, unknown> = { title: movie.title, summarySyncedAt: syncedAt };
  for (const key of ['overview', 'posterPath', 'backdropPath'] as const) {
    if (movie[key] !== undefined) update[key] = movie[key];
  }
  return update;
}

function resolveLocalization(
  localization: MovieLocalizationDocument | null | undefined,
  originalTitle: string | undefined,
): ResolvedLocalization | undefined {
  const title = localization?.title || originalTitle;
  if (!title || !localization) return undefined;
  return {
    locale: localization.locale,
    title,
    summarySyncedAt: localization.summarySyncedAt,
    ...(localization.overview ? { overview: localization.overview } : {}),
    ...(localization.tagline ? { tagline: localization.tagline } : {}),
    ...(localization.posterPath ? { posterPath: localization.posterPath } : {}),
    ...(localization.backdropPath ? { backdropPath: localization.backdropPath } : {}),
    ...(localization.genres
      ? { genres: localization.genres.map((genre) => ({ tmdbId: genre.tmdbId, name: genre.name })) }
      : {}),
    ...(localization.trailer
      ? {
          trailer: {
            tmdbVideoId: localization.trailer.tmdbVideoId,
            provider: 'youtube',
            providerVideoId: localization.trailer.providerVideoId,
            name: localization.trailer.name,
            ...(localization.trailer.language ? { language: localization.trailer.language } : {}),
            ...(localization.trailer.region ? { region: localization.trailer.region } : {}),
            official: localization.trailer.official,
            ...(localization.trailer.publishedAt ? { publishedAt: localization.trailer.publishedAt } : {}),
          },
        }
      : {}),
    ...(localization.detailSyncedAt ? { detailSyncedAt: localization.detailSyncedAt } : {}),
    ...(localization.trailerSyncedAt ? { trailerSyncedAt: localization.trailerSyncedAt } : {}),
  };
}

function fromDocuments(movie: MovieDocument, localized: ResolvedLocalization): MovieRecord {
  const result: MovieRecord = {
    tmdbId: movie.tmdbId,
    title: localized.title,
    genreIds: movie.genreIds ?? [],
    summarySyncedAt: localized.summarySyncedAt,
    localizationLocale: localized.locale as Locale,
  };
  if (movie.originalTitle) result.originalTitle = movie.originalTitle;
  if (movie.originalLanguage) result.originalLanguage = movie.originalLanguage;
  if (localized.overview) result.overview = localized.overview;
  const posterPath = localized.posterPath ?? movie.posterPath;
  const backdropPath = localized.backdropPath ?? movie.backdropPath;
  if (posterPath) result.posterPath = posterPath;
  if (backdropPath) result.backdropPath = backdropPath;
  if (movie.releaseDate instanceof Date) result.releaseDate = movie.releaseDate.toISOString().slice(0, 10);
  if (typeof movie.voteAverage === 'number') result.voteAverage = movie.voteAverage;
  if (typeof movie.voteCount === 'number') result.voteCount = movie.voteCount;
  return result;
}
