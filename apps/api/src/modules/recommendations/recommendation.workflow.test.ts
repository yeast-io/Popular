import assert from 'node:assert/strict';
import test from 'node:test';
import { RecommendationWorkflow } from './recommendation.workflow.js';
import type { DiscoveryProvider } from './recommendation.types.js';
import { MongoRecommendationStore } from '../../infrastructure/mongodb/recommendations/recommendation.store.js';
import type { MovieCatalogStore, MovieStatusStore } from '../movies/movie.types.js';
import type { LlmGenerateInput } from '../llm/llm.types.js';
import { emptyProfile } from '../preferences/preference.domain.js';

function setup() {
  let data: Record<string, unknown> | undefined;
  let leaseId: string | undefined;
  let queries = 0, calls = 0;
  let blockOnRecheck = false, stateReads = 0;
  const query = (get: () => unknown) => ({ lean: () => ({ exec: async () => get() }) });
  const model = {
    findOne: () => query(() => data ? { data: structuredClone(data), updatedAt: new Date() } : null),
    findOneAndUpdate: (_filter: unknown, update: { $set: { leaseId: string } }) => query(() => {
      if (leaseId) return null; leaseId = update.$set.leaseId; return { data };
    }),
    updateOne: (filter: { ownerId: string; leaseId?: string }, update: { $setOnInsert?: { data: Record<string, unknown> }; $set?: { data: Record<string, unknown> }; $unset?: unknown }) => ({ exec: async () => {
      assert.equal(filter.ownerId, 'alice');
      if (!data && update.$setOnInsert) data = structuredClone(update.$setOnInsert.data);
      if (filter.leaseId && filter.leaseId !== leaseId) return { matchedCount: 0 };
      if (update.$set) data = structuredClone(update.$set.data);
      if (update.$unset) leaseId = undefined;
      return { matchedCount: 1 };
    } }),
  };
  const store = new MongoRecommendationStore(model as unknown as ConstructorParameters<typeof MongoRecommendationStore>[0]);
  const profiles = { read: async () => emptyProfile() };
  const provider = {
    discover: async () => { queries++; return [1, 2, 3].map(id => ({ tmdbId: id, title: `Movie ${id}`, genreIds: [10752] })); },
    fetchDetails: async (id: number) => ({ tmdbId: id, title: `Movie ${id}`, genreIds: [10752], genres: [], cast: [], directors: [], runtimeMinutes: 100 }),
  } as unknown as DiscoveryProvider;
  const statuses = { list: async () => ({ items: [], total: 0 }), readForMovies: async () => [
    { tmdbId: 1, status: 'watched', preference: 'liked' }, { tmdbId: 2, status: 'unwatched', preference: 'disliked' },
    ...(stateReads++ > 0 && blockOnRecheck ? [{ tmdbId: 3, status: 'watched', preference: 'neutral' }] : []),
  ] } as unknown as MovieStatusStore;
  const catalog = { writeMovieDetail: async () => {} } as unknown as MovieCatalogStore;
  const service = new RecommendationWorkflow(store, profiles, provider, catalog, statuses, 'zh-CN');
  const llm = { generate: async (request: LlmGenerateInput) => {
    calls++;
    return { content: JSON.stringify(request.outputSchema?.name === 'recommendation_plan'
      ? { question: '今天想看什么？', genres: [10752], excludeGenres: [], referenceTitle: null, maxRuntime: null, language: null, unverifiableRestrictions: [] }
      : { movies: [{ tmdbId: 3, reason: '符合战争题材要求' }] }), inputTokens: 1, outputTokens: 1 };
  } };
  return { service, llm, queries: () => queries, calls: () => calls, data: () => data, blockOnRecheck: () => { blockOnRecheck = true; } };
}
test('workflow enforces at most three clarification questions even if the model asks a fourth', async () => {
  const state = setup();
  for (let i = 1; i <= 3; i++) {
    assert.equal(await state.service.run('alice', 'telegram:1', `msg${i}`, '推荐电影', [], state.llm), '今天想看什么？');
  }
  assert.equal(state.queries(), 0);
  const reply = await state.service.run('alice', 'telegram:1', 'msg4', '随便', [], state.llm);
  assert.match(reply, /Movie 3/);
  assert.doesNotMatch(reply, /Movie 1|Movie 2/);
  assert.equal(state.data()?.active, false);
  assert.equal(state.queries(), 2);
});
test('recommend now bypasses model clarification; replay reuses the batch without querying again', async () => {
  const state = setup();
  const reply = await state.service.run('alice', 'web:thread1', 'msg1', '先推荐', [], state.llm);
  assert.match(reply, /Movie 3/);
  const calls = state.calls();
  assert.equal(await state.service.run('alice', 'web:thread1', 'msg1', '先推荐', [], state.llm), reply);
  assert.equal(state.calls(), calls);
  assert.equal(state.queries(), 2);
});
test('unknown candidate IDs cannot be delivered as recommendations', async () => {
  const state = setup();
  const llm = { generate: async (input: LlmGenerateInput) => input.outputSchema?.name === 'recommendation_ranking'
    ? { content: '{"movies":[{"tmdbId":99999,"reason":"invented"}]}', inputTokens: 1, outputTokens: 1 }
    : state.llm.generate(input) };
  await assert.rejects(state.service.run('alice', 'telegram:1', 'msg1', '立即推荐', [], llm), /Unknown recommendation candidate/);
});
test('a movie marked watched during ranking is removed before delivery', async () => {
  const state = setup(); state.blockOnRecheck();
  const reply = await state.service.run('alice', 'web:thread1', 'msg1', '先推荐', [], state.llm);
  assert.doesNotMatch(reply, /Movie 3/);
  assert.deepEqual((state.data()?.batches as Array<{ movieIds: number[] }>)[0]?.movieIds, []);
});
test('unverifiable hard content restrictions fail closed without querying or inventing results', async () => {
  const state = setup();
  const llm = { generate: async () => ({ content: JSON.stringify({ question: null, genres: [], excludeGenres: [], referenceTitle: null,
    maxRuntime: null, language: null, unverifiableRestrictions: ['完全没有血腥'] }), inputTokens: 1, outputTokens: 1 }) };
  const reply = await state.service.run('alice', 'web:thread1', 'msg1', '立即推荐但必须完全没有血腥', [], llm);
  assert.match(reply, /无法可靠核实/);
  assert.equal(state.queries(), 0);
});
