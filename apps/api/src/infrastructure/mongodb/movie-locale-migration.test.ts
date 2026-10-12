import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertStateAssociationsPreserved,
  legacyMovieFilter,
  migratedLocale,
  selectCanonicalMovies,
  toBaseMovieUpdate,
  toLocalizationInsert,
} from './movie-locale-migration.js';

test('migration recognizes legacy localized fields even when locale is absent', () => {
  assert.ok(legacyMovieFilter.$or.some((condition) => 'title' in condition));
  assert.equal(migratedLocale, 'zh-CN');
});

test('migration moves localized fields and keeps language-independent fields in movies', () => {
  const updatedAt = new Date('2026-10-01T00:00:00.000Z');
  const movie = {
    _id: 'movie-1', tmdbId: 42, title: '中文标题', originalTitle: 'Original', overview: '中文简介',
    tagline: '中文标语', genres: [{ tmdbId: 18, name: '剧情' }], genreIds: [18],
    posterPath: '/poster.jpg', releaseDate: new Date('2026-09-01'), voteAverage: 8.1,
    voteCount: 100, imdbId: 'tt42', runtimeMinutes: 120, updatedAt,
  };

  assert.deepEqual(toLocalizationInsert(movie), {
    movieTmdbId: 42, locale: 'zh-CN', title: '中文标题', overview: '中文简介', tagline: '中文标语',
    genres: [{ tmdbId: 18, name: '剧情' }], summarySyncedAt: updatedAt,
  });
  assert.deepEqual(toBaseMovieUpdate(movie), {
    tmdbId: 42, originalTitle: 'Original', posterPath: '/poster.jpg', genreIds: [18],
    releaseDate: new Date('2026-09-01'), voteAverage: 8.1, voteCount: 100,
    imdbId: 'tt42', runtimeMinutes: 120,
  });
});

test('canonical selection keeps the newest row when input is sorted newest first', () => {
  const newest = { _id: 'new', tmdbId: 42, title: '新标题' };
  const older = { _id: 'old', tmdbId: 42, title: '旧标题' };
  const selected = selectCanonicalMovies([newest, older]);
  assert.equal(selected.size, 1);
  assert.equal(selected.get(42)?._id, 'new');
});

test('canonical selection can retain an already-cleaned row during a retry', () => {
  const cleanedCanonical = { _id: 'cleaned', tmdbId: 42 };
  const remainingLegacyDuplicate = { _id: 'legacy', tmdbId: 42, title: '旧标题' };
  const selected = selectCanonicalMovies([cleanedCanonical, remainingLegacyDuplicate]);
  assert.equal(selected.get(42)?._id, 'cleaned');
});

test('state association verification permits a repeatable no-op but rejects loss', () => {
  const snapshot = { total: 3, resolvedTmdbIds: 2, danglingTmdbIds: 0 };
  assert.doesNotThrow(() => assertStateAssociationsPreserved(snapshot, snapshot));
  assert.throws(
    () => assertStateAssociationsPreserved(snapshot, { ...snapshot, resolvedTmdbIds: 1, danglingTmdbIds: 1 }),
    /associations changed/,
  );
});
