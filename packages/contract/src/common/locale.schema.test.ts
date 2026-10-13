import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { MyMoviesQuerySchema } from '../movie_statuses/movie-status.schema.js';
import { LoadMoreTrendingRequestSchema, MovieDetailQuerySchema, SearchMoviesQuerySchema, TrendingQuerySchema } from '../movies/movie.schema.js';
import { LocaleSchema } from './locale.schema.js';

test('locale contract accepts only the two supported locale values', () => {
  assert.equal(Value.Check(LocaleSchema, 'zh-CN'), true);
  assert.equal(Value.Check(LocaleSchema, 'en-US'), true);
  assert.equal(Value.Check(LocaleSchema, 'fr-FR'), false);
});

test('movie query contracts reject an unsupported locale', () => {
  assert.equal(Value.Check(TrendingQuerySchema, { locale: 'fr-FR' }), false);
  assert.equal(Value.Check(SearchMoviesQuerySchema, { query: 'movie', locale: 'fr-FR' }), false);
  assert.equal(Value.Check(MovieDetailQuerySchema, { locale: 'fr-FR' }), false);
  assert.equal(Value.Check(MyMoviesQuerySchema, { locale: 'fr-FR' }), false);
  assert.equal(Value.Check(LoadMoreTrendingRequestSchema, { page: 1, locale: 'fr-FR' }), false);
});

test('load-more requires a valid trending generation', () => {
  const generation = '00000000-0000-4000-8000-000000000001';
  assert.equal(Value.Check(LoadMoreTrendingRequestSchema, { page: 1, generation, locale: 'zh-CN' }), true);
  assert.equal(Value.Check(LoadMoreTrendingRequestSchema, { page: 1, locale: 'zh-CN' }), false);
  assert.equal(Value.Check(LoadMoreTrendingRequestSchema, { page: 1, generation: 'not-a-uuid', locale: 'zh-CN' }), false);
});
