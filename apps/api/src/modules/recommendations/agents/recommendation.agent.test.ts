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
      ? { question: null, genres: [10752], excludeGenres: [], referenceTitle: null, maxRuntime: null, language: null, unverifiableRestrictions: [] }
      : { movies: [{ tmdbId: 1, reason: 'Matches the requested genre' }] }), inputTokens: 1, outputTokens: 1 };
  } });
  const signal = new AbortController().signal;
  const profile = emptyProfile();
  assert.deepEqual((await agent.plan(profile, 3, true, [{ role: 'user', content: '先推荐战争片' }], signal)).genres, [10752]);
  assert.equal((await agent.rank(profile, [], [{ tmdbId: 1, title: 'Candidate', genreIds: [10752], genres: [], directors: [], cast: [] }], signal)).movies[0]?.tmdbId, 1);
  assert.equal(requests.length, 2);
  assert.ok(requests[0]?.messages[1]?.content.includes('"immediate":true'));
  assert.ok(requests[1]?.messages[1]?.content.includes('Candidate'));
  assert.equal(requests[0]?.signal, signal);
});

test('malformed ranking output fails at the model boundary', async () => {
  const agent = new RecommendationAgent({ generate: async () => ({ content: '{"movies":[{"tmdbId":"invented"}]}', inputTokens: 1, outputTokens: 1 }) });
  await assert.rejects(agent.rank(emptyProfile(), [], [], new AbortController().signal));
});
