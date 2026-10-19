import type { Connection } from 'mongoose';

export const legacyMovieFilter = {
  $or: [
    { locale: { $exists: true } },
    { title: { $exists: true } },
    { overview: { $exists: true } },
    { tagline: { $exists: true } },
    { genres: { $exists: true } },
    { summarySyncedAt: { $exists: true } },
    { detailSyncedAt: { $exists: true } },
    { activeCreditVersion: { $exists: true } },
  ],
};

export const migratedLocale = 'zh-CN' as const;

interface LegacyMovie {
  _id: unknown;
  tmdbId?: unknown;
  title?: unknown;
  originalTitle?: unknown;
  overview?: unknown;
  tagline?: unknown;
  genres?: unknown;
  posterPath?: unknown;
  backdropPath?: unknown;
  genreIds?: unknown;
  releaseDate?: unknown;
  voteAverage?: unknown;
  voteCount?: unknown;
  imdbId?: unknown;
  runtimeMinutes?: unknown;
  summarySyncedAt?: unknown;
  detailSyncedAt?: unknown;
  activeCreditVersion?: unknown;
  updatedAt?: unknown;
}

export interface MovieLocaleMigrationReport {
  dryRun: boolean;
  migratedLocale: typeof migratedLocale;
  legacyMovieRows: number;
  localizationRowsToInsert: number;
  existingLocalizationRowsPreserved: number;
  consolidatedMovies: number;
  duplicateMovieRowsToRemove: number;
  assignedDefaultLocale: { people: number; movieCredits: number };
  stateAssociations: { total: number; resolvedTmdbIds: number; danglingTmdbIds: number };
}

export async function migrateMovieLocales(
  connection: Connection,
  options: { dryRun?: boolean } = {},
): Promise<MovieLocaleMigrationReport> {
  const database = connection.db;
  if (!database) throw new Error('MongoDB database handle is unavailable');

  const dryRun = options.dryRun ?? false;
  const movies = database.collection('movies');
  const localizations = database.collection('movie_localizations');
  const people = database.collection('people');
  const credits = database.collection('movie_credits');
  const states = database.collection('user_movie_states');
  const legacyMovies: LegacyMovie[] = await movies.find(legacyMovieFilter).sort({ updatedAt: -1, _id: 1 }).toArray();
  validateLegacyMovies(legacyMovies);

  const localizationSourceByTmdbId = selectCanonicalMovies(legacyMovies);
  // Include already-cleaned rows for affected IDs. This closes the retry window where a
  // canonical row was cleaned but the older duplicate row had not yet been deleted.
  const affectedTmdbIds = [...localizationSourceByTmdbId.keys()];
  const affectedMovies: LegacyMovie[] =
    affectedTmdbIds.length === 0
      ? []
      : await movies
          .find({ tmdbId: { $in: affectedTmdbIds } })
          .sort({ updatedAt: -1, _id: 1 })
          .toArray();
  const canonicalByTmdbId = selectCanonicalMovies(affectedMovies);
  const duplicateIds = affectedMovies
    .filter((movie) => canonicalByTmdbId.get(movie.tmdbId as number)?._id !== movie._id)
    .map(({ _id }) => _id);
  const existingLocalizationCount =
    legacyMovies.length === 0
      ? 0
      : await localizations.countDocuments({
          locale: migratedLocale,
          movieTmdbId: { $in: affectedTmdbIds },
        });
  const stateBefore = await stateAssociationSnapshot(states, movies);
  const peopleWithoutLocale = await people.countDocuments({ locale: { $exists: false } });
  const creditsWithoutLocale = await credits.countDocuments({ locale: { $exists: false } });

  const report: MovieLocaleMigrationReport = {
    dryRun,
    migratedLocale,
    legacyMovieRows: legacyMovies.length,
    localizationRowsToInsert: Math.max(0, localizationSourceByTmdbId.size - existingLocalizationCount),
    existingLocalizationRowsPreserved: existingLocalizationCount,
    consolidatedMovies: canonicalByTmdbId.size,
    duplicateMovieRowsToRemove: duplicateIds.length,
    assignedDefaultLocale: { people: peopleWithoutLocale, movieCredits: creditsWithoutLocale },
    stateAssociations: stateBefore,
  };
  if (dryRun) return report;

  // Fail before touching legacy rows if existing localization identities are inconsistent.
  await localizations.createIndex({ movieTmdbId: 1, locale: 1 }, { unique: true });

  if (localizationSourceByTmdbId.size > 0) {
    await localizations.bulkWrite(
      [...localizationSourceByTmdbId.values()].map((movie) => {
        return {
          updateOne: {
            filter: { movieTmdbId: movie.tmdbId, locale: migratedLocale },
            // A retry must not overwrite localization data written by the new application.
            update: { $setOnInsert: toLocalizationInsert(movie) },
            upsert: true,
          },
        };
      }),
      { ordered: false },
    );

    for (const movie of canonicalByTmdbId.values()) {
      await movies.updateOne(
        { _id: movie._id as never },
        { $set: toBaseMovieUpdate(movie), $unset: localizedMovieFields },
      );
    }
  }
  if (duplicateIds.length > 0) await movies.deleteMany({ _id: { $in: duplicateIds as never[] } });

  const [peopleUpdate, creditUpdate] = await Promise.all([
    people.updateMany({ locale: { $exists: false } }, { $set: { locale: migratedLocale } }),
    credits.updateMany({ locale: { $exists: false } }, { $set: { locale: migratedLocale } }),
  ]);
  report.assignedDefaultLocale = {
    people: peopleUpdate.modifiedCount,
    movieCredits: creditUpdate.modifiedCount,
  };

  await dropIndexByShape(movies, { tmdbId: 1, locale: 1 });
  await movies.createIndex({ tmdbId: 1 }, { unique: true });
  await people.createIndex({ tmdbId: 1, locale: 1 }, { unique: true });
  await credits.createIndex({ movieTmdbId: 1, locale: 1, syncVersion: 1, tmdbCreditId: 1 }, { unique: true });
  await dropIndexByShape(people, { tmdbId: 1 });

  const stateAfter = await stateAssociationSnapshot(states, movies);
  assertStateAssociationsPreserved(stateBefore, stateAfter);
  report.stateAssociations = stateAfter;
  return report;
}

export function selectCanonicalMovies<T extends LegacyMovie>(movies: readonly T[]): Map<number, T> {
  const result = new Map<number, T>();
  for (const movie of movies) {
    const tmdbId = movie.tmdbId as number;
    if (!result.has(tmdbId)) result.set(tmdbId, movie);
  }
  return result;
}

export function toLocalizationInsert(movie: LegacyMovie): Record<string, unknown> {
  return compact({
    movieTmdbId: movie.tmdbId,
    locale: migratedLocale,
    title: movie.title,
    overview: movie.overview,
    tagline: movie.tagline,
    genres: movie.genres,
    summarySyncedAt: movie.summarySyncedAt ?? movie.updatedAt ?? new Date(),
    detailSyncedAt: movie.detailSyncedAt,
    activeCreditVersion: movie.activeCreditVersion,
  });
}

export function toBaseMovieUpdate(movie: LegacyMovie): Record<string, unknown> {
  return compact({
    tmdbId: movie.tmdbId,
    originalTitle: movie.originalTitle,
    posterPath: movie.posterPath,
    backdropPath: movie.backdropPath,
    genreIds: movie.genreIds ?? [],
    releaseDate: movie.releaseDate,
    voteAverage: movie.voteAverage,
    voteCount: movie.voteCount,
    imdbId: movie.imdbId,
    runtimeMinutes: movie.runtimeMinutes,
  });
}

export function assertStateAssociationsPreserved(
  before: MovieLocaleMigrationReport['stateAssociations'],
  after: MovieLocaleMigrationReport['stateAssociations'],
): void {
  if (
    before.total !== after.total ||
    before.resolvedTmdbIds !== after.resolvedTmdbIds ||
    before.danglingTmdbIds !== after.danglingTmdbIds
  ) {
    throw new Error(
      `Movie-state associations changed during migration: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    );
  }
}

const localizedMovieFields = {
  locale: '',
  title: '',
  overview: '',
  tagline: '',
  genres: '',
  summarySyncedAt: '',
  detailSyncedAt: '',
  activeCreditVersion: '',
  metadataLevel: '',
  schemaVersion: '',
};

function validateLegacyMovies(movies: readonly LegacyMovie[]): void {
  const invalid = movies.filter((movie) => {
    return (
      typeof movie.tmdbId !== 'number' ||
      !Number.isInteger(movie.tmdbId) ||
      movie.tmdbId < 1 ||
      typeof movie.title !== 'string' ||
      movie.title.trim().length === 0
    );
  });
  if (invalid.length > 0) {
    throw new Error(
      `Migration aborted before writes: ${invalid.length} legacy movie row(s) have an invalid tmdbId or title`,
    );
  }
}

async function stateAssociationSnapshot(
  states: ReturnType<NonNullable<Connection['db']>['collection']>,
  movies: ReturnType<NonNullable<Connection['db']>['collection']>,
): Promise<MovieLocaleMigrationReport['stateAssociations']> {
  const [total, stateTmdbIds] = await Promise.all([
    states.countDocuments({}),
    states.distinct('tmdbId') as Promise<unknown[]>,
  ]);
  const validIds = stateTmdbIds.filter((value): value is number => typeof value === 'number');
  const resolvedTmdbIds =
    validIds.length === 0 ? 0 : (await movies.distinct('tmdbId', { tmdbId: { $in: validIds } })).length;
  return { total, resolvedTmdbIds, danglingTmdbIds: validIds.length - resolvedTmdbIds };
}

async function dropIndexByShape(
  collection: ReturnType<NonNullable<Connection['db']>['collection']>,
  expectedKey: Record<string, number>,
): Promise<void> {
  const indexes = await collection.indexes();
  const match = indexes.find(({ key }) => JSON.stringify(key) === JSON.stringify(expectedKey));
  if (match?.name) await collection.dropIndex(match.name);
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}
