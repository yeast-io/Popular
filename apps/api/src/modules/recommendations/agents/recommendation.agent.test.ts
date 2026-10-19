import assert from 'node:assert/strict';
import test from 'node:test';
import { RecommendationAgent } from './recommendation.agent.js';
import { emptyProfile } from '../../preferences/preference.domain.js';
import type { LlmGenerateInput } from '../../llm/llm.types.js';

test('recommendation agent plans and ranks using only supplied context and candidate metadata', async () => {
  const requests: LlmGenerateInput[] = [];
  const agent = new RecommendationAgent({ generate: async input => {
    requests.push(input);
    return { content: JSON.stringify(input.outputSchema?.name === 'recommendation_plan'
      ? { requestedCount: 2, softPreferences: ['Bolder romance'], recommendNow: true, question: null, genres: [10752], excludeGenres: [], referenceTitle: null, maxRuntime: null, language: null, unverifiableRestrictions: [] }
      : { movies: [{ tmdbId: 1, reason: 'Matches the requested genre' }] }), inputTokens: 1, outputTokens: 1 };
  } });
  const signal = new AbortController().signal;
  const profile = emptyProfile();
  assert.deepEqual((await agent.plan(profile, 3, [{ role: 'user', content: '先推荐战争片' }], signal, 'en-US')).genres, [10752]);
  assert.equal((await agent.rank(profile, [], [{ tmdbId: 1, title: 'Candidate', genreIds: [10752], genres: [], directors: [], cast: [] }], signal, 'en-US', { requestedCount: 2, softPreferences: ['Bolder romance'] })).movies[0]?.tmdbId, 1);
  assert.equal(requests.length, 2);
  const rankingInput = JSON.parse(requests[1]!.messages[1]!.content);
  assert.equal(rankingInput.requestedCount, 2);
  assert.deepEqual(rankingInput.softPreferences, ['Bolder romance']);
  const rankingSchema = requests[1]!.outputSchema!.schema as { properties: { movies: { maxItems: number } } };
  assert.equal(rankingSchema.properties.movies.maxItems, 2);
  assert.equal(JSON.parse(requests[0]!.messages[1]!.content).responseLocale, 'en-US');
  assert.equal(JSON.parse(requests[1]!.messages[1]!.content).responseLocale, 'en-US');
  assert.ok(requests[0]!.outputSchema!.schema.required instanceof Array);
  assert.ok((requests[0]!.outputSchema!.schema.required as string[]).includes('recommendNow'));
  assert.ok(requests[1]?.messages[1]?.content.includes('Candidate'));
  assert.equal(requests[0]?.signal, signal);
});

test('malformed ranking output fails at the model boundary', async () => {
  const agent = new RecommendationAgent({ generate: async () => ({ content: '{"movies":[{"tmdbId":"invented"}]}', inputTokens: 1, outputTokens: 1 }) });
  await assert.rejects(agent.rank(emptyProfile(), [], [], new AbortController().signal, 'zh-CN', { requestedCount: 5, softPreferences: [] }));
});

test('missing or non-boolean immediate intent fails at the model boundary', async () => {
  for (const recommendNow of [undefined, 'true']) {
    const agent = new RecommendationAgent({ generate: async () => ({ content: JSON.stringify({ requestedCount: 5, softPreferences: [], recommendNow,
      question: null, genres: [], excludeGenres: [], referenceTitle: null, maxRuntime: null, language: null,
      unverifiableRestrictions: [] }), inputTokens: 1, outputTokens: 1 }) });
    await assert.rejects(agent.plan(emptyProfile(), 0, [], new AbortController().signal, 'en-US'));
  }
});

test('invalid recommendation counts fail at the planning boundary', async () => {
  for (const requestedCount of [undefined, 0, -1, 6, 2.5, '2']) {
    const agent = new RecommendationAgent({ generate: async () => ({ content: JSON.stringify({ requestedCount,
      softPreferences: [], recommendNow: false, question: null, genres: [], excludeGenres: [], referenceTitle: null,
      maxRuntime: null, language: null, unverifiableRestrictions: [] }), inputTokens: 1, outputTokens: 1 }) });
    await assert.rejects(agent.plan(emptyProfile(), 0, [], new AbortController().signal, 'zh-CN'));
  }
});
