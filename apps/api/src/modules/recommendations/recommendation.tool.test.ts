import assert from 'node:assert/strict';
import type { Locale } from '@movie-hub/contract';
import { AiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import test from 'node:test';
import { RecommendationTool } from './recommendation.tool.js';
import type { DiscoveryProvider, RecommendationFilters } from './recommendation.types.js';
import { MongoRecommendationStore } from '../../infrastructure/mongodb/recommendations/recommendation.store.js';
import type { MovieCatalogStore, MovieStatusStore } from '../movies/movie.types.js';
import type { LlmClient, LlmMessage, LlmGenerateInput } from '../llm/llm.types.js';
import { AssistantAgent } from '../assistant/agents/assistant.agent.js';
import { emptyProfile } from '../preferences/preference.domain.js';

function setup(
  options: {
    requestedCount?: number;
    softPreferences?: string[];
    question?: string | null;
    candidateIds?: number[];
    genres?: number[];
    rankedMovies?: Array<{ tmdbId: number; reason: string }>;
    recommendNow?: boolean;
    locale?: Locale;
    noCandidates?: boolean;
    releaseError?: Error;
    diagnostics?: { logger?: AiLogger; verbose: boolean };
  } = {}
) {
  let data: Record<string, unknown> | undefined;
  let leaseId: string | undefined;
  let queries = 0,
    calls = 0;
  let blockOnRecheck = false,
    stateReads = 0;
  const discoveryFilters: RecommendationFilters[] = [];
  const rankingInputs: Array<{ requestedCount: number; softPreferences: string[]; responseLocale: Locale }> = [];
  const planInputs: Array<{ questions: number; conversation: Array<{ content: string }>; responseLocale: Locale }> = [];
  const query = (get: () => unknown) => ({ lean: () => ({ exec: async () => get() }) });
  const model = {
    // Mongo timestamps are fresh after ensure/acquire; expiry must not depend on them.
    findOne: () => {
      return query(() => (data ? { data: structuredClone(data), updatedAt: new Date() } : null));
    },
    findOneAndUpdate: (_filter: unknown, update: { $set: { leaseId: string } }) => {
      return query(() => {
        if (leaseId) return null;
        leaseId = update.$set.leaseId;
        return { data };
      });
    },
    updateOne: (
      filter: { ownerId: string; leaseId?: string },
      update: {
        $setOnInsert?: { data: Record<string, unknown> };
        $set?: { data: Record<string, unknown> };
        $unset?: unknown;
      }
    ) => {
      return {
        exec: async () => {
          assert.equal(filter.ownerId, 'alice');
          if (!data && update.$setOnInsert) data = structuredClone(update.$setOnInsert.data);
          if (filter.leaseId && filter.leaseId !== leaseId) return { matchedCount: 0 };
          if (update.$set) data = structuredClone(update.$set.data);
          if (update.$unset) {
            if (options.releaseError) throw options.releaseError;
            leaseId = undefined;
          }
          return { matchedCount: 1 };
        },
      };
    },
  };
  const store = new MongoRecommendationStore(
    model as unknown as ConstructorParameters<typeof MongoRecommendationStore>[0]
  );
  const profiles = { read: async () => emptyProfile() };
  const provider = {
    discover: async (filters: RecommendationFilters) => {
      discoveryFilters.push(structuredClone(filters));
      queries++;
      return (options.noCandidates ? [] : (options.candidateIds ?? [1, 2, 3])).map((id) => {
        return {
          tmdbId: id,
          title: `Movie ${id}`,
          genreIds: options.genres ?? [10752],
        };
      });
    },
    fetchDetails: async (id: number) => {
      return {
        tmdbId: id,
        title: `Movie ${id}`,
        posterPath: '/poster.jpg',
        genreIds: options.genres ?? [10752],
        genres: [],
        cast: [],
        directors: [],
        runtimeMinutes: 100,
      };
    },
  } as unknown as DiscoveryProvider;
  const statuses = {
    list: async () => ({ items: [], total: 0 }),
    readForMovies: async () => {
      return [
        { tmdbId: 1, status: 'watched', preference: 'liked' },
        { tmdbId: 2, status: 'unwatched', preference: 'disliked' },
        ...(stateReads++ > 0 && blockOnRecheck ? [{ tmdbId: 3, status: 'watched', preference: 'neutral' }] : []),
      ];
    },
  } as unknown as MovieStatusStore;
  const catalog = { writeMovieDetail: async () => {} } as unknown as MovieCatalogStore;
  const tool = new RecommendationTool(
    store,
    profiles,
    provider,
    catalog,
    statuses,
    options.locale ?? 'zh-CN',
    options.diagnostics
  );
  const llm = {
    generate: async (request: LlmGenerateInput) => {
      calls++;
      if (request.outputSchema?.name === 'recommendation_plan')
        planInputs.push(JSON.parse(request.messages[1]!.content));
      else rankingInputs.push(JSON.parse(request.messages[1]!.content));
      return {
        content: JSON.stringify(
          request.outputSchema?.name === 'recommendation_plan'
            ? {
                requestedCount: options.requestedCount ?? 5,
                softPreferences: options.softPreferences ?? [],
                recommendNow: options.recommendNow ?? false,
                question: options.question === undefined ? '今天想看什么？' : options.question,
                genres: options.genres ?? [10752],
                excludeGenres: [],
                referenceTitle: null,
                maxRuntime: null,
                language: null,
                unverifiableRestrictions: [],
              }
            : { movies: options.rankedMovies ?? [{ tmdbId: 3, reason: '符合战争题材要求' }] }
        ),
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
  // Exercise the real unified agent's model decisions against the deterministic tool.
  const runResult = (
    ownerId: string,
    conversation: string,
    eventId: string,
    text: string,
    history: LlmMessage[],
    client: Pick<LlmClient, 'generate'>,
    locale?: Locale
  ) => {
    const agent = new AssistantAgent(client, {
      systemPrompt: 'Be concise.',
      maxContextTokens: 32_000,
      maxOutputTokens: 500,
    });
    return tool.runResult(
      ownerId,
      conversation,
      eventId,
      text,
      history,
      {
        plan: agent.planRecommendation.bind(agent),
        rank: agent.rankRecommendations.bind(agent),
      },
      undefined,
      locale
    );
  };
  const service = {
    active: tool.active.bind(tool),
    runResult,
    run: async (...args: Parameters<typeof runResult>) => {
      return (await runResult(...args)).replyText;
    },
  };
  return {
    service,
    llm,
    queries: () => queries,
    calls: () => calls,
    data: () => data,
    plans: () => {
      return planInputs;
    },
    filters: () => {
      return discoveryFilters;
    },
    rankings: () => {
      return rankingInputs;
    },
    blockOnRecheck: () => {
      blockOnRecheck = true;
    },
  };
}
test('recommendation tool enforces at most three clarification questions even if the model asks a fourth', async () => {
  const state = setup();
  for (let i = 1; i <= 3; i++) {
    assert.equal(
      await state.service.run('alice', 'telegram:1', `msg${i}`, '推荐电影', [], state.llm),
      '今天想看什么？'
    );
  }
  assert.equal(state.queries(), 0);
  const reply = await state.service.run('alice', 'telegram:1', 'msg4', '随便', [], state.llm);
  assert.match(reply, /Movie 3/);
  assert.doesNotMatch(reply, /Movie 1|Movie 2/);
  assert.equal(state.data()?.active, false);
  assert.equal(state.queries(), 2);
});
test('recommend now bypasses model clarification; replay reuses the batch without querying again', async () => {
  const state = setup({ recommendNow: true });
  const reply = await state.service.run('alice', 'web:thread1', 'msg1', '先推荐', [], state.llm);
  assert.match(reply, /Movie 3/);
  const calls = state.calls();
  assert.equal(await state.service.run('alice', 'web:thread1', 'msg1', '先推荐', [], state.llm), reply);
  assert.equal(state.calls(), calls);
  assert.equal(state.queries(), 2);
});
test('unknown candidate IDs cannot be delivered as recommendations', async () => {
  const state = setup({ recommendNow: true });
  const llm = {
    generate: async (input: LlmGenerateInput) => {
      return input.outputSchema?.name === 'recommendation_ranking'
        ? { content: '{"movies":[{"tmdbId":99999,"reason":"invented"}]}', inputTokens: 1, outputTokens: 1 }
        : state.llm.generate(input);
    },
  };
  await assert.rejects(
    state.service.run('alice', 'telegram:1', 'msg1', '立即推荐', [], llm),
    /Unknown recommendation candidate/
  );
});
test('a movie marked watched during ranking is removed before delivery', async () => {
  const state = setup({ recommendNow: true });
  state.blockOnRecheck();
  const reply = await state.service.run('alice', 'web:thread1', 'msg1', '先推荐', [], state.llm);
  assert.doesNotMatch(reply, /Movie 3/);
  assert.deepEqual((state.data()?.batches as Array<{ movieIds: number[] }>)[0]?.movieIds, []);
});
test('unverifiable hard content restrictions fail closed without querying or inventing results', async () => {
  const state = setup();
  const llm = {
    generate: async () => {
      return {
        content: JSON.stringify({
          requestedCount: 5,
          softPreferences: [],
          recommendNow: true,
          question: null,
          genres: [],
          excludeGenres: [],
          referenceTitle: null,
          maxRuntime: null,
          language: null,
          unverifiableRestrictions: ['完全没有血腥'],
        }
        ),
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
  const reply = await state.service.run('alice', 'web:thread1', 'msg1', '立即推荐但必须完全没有血腥', [], llm);
  assert.match(reply, /无法可靠核实/);
  assert.equal(state.queries(), 0);
});

for (const text of [
  '我没说让你直接推荐',
  'I did not ask you to stop asking questions',
  '他刚才说“直接推荐”，我还没决定',
]) {
  test(`structured negative intent allows clarification despite keyword mentions: ${text}`, async () => {
    const state = setup({ recommendNow: false });
    assert.equal(await state.service.run('alice', 'web:thread1', 'msg1', text, [], state.llm), '今天想看什么？');
    assert.equal(state.queries(), 0);
  });
}

test('structured immediate intent bypasses clarification without any trigger keyword', async () => {
  const state = setup({ recommendNow: true });
  assert.match(
    await state.service.run('alice', 'web:thread1', 'msg1', 'Give me your picks, please', [], state.llm),
    /Movie 3/
  );
  assert.equal(state.calls(), 2);
});

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(`${locale} localizes the no-candidate and insufficient-evidence replies`, async () => {
    const empty = setup({ locale, recommendNow: true, noCandidates: true });
    const emptyReply = await empty.service.run('alice', 'web:thread1', 'msg1', 'Recommend', [], empty.llm);
    assert.match(emptyReply, locale === 'zh-CN' ? /没有找到符合条件/ : /No movies matched your criteria/);
    const blocked = setup({ locale, recommendNow: true });
    blocked.blockOnRecheck();
    const blockedReply = await blocked.service.run('alice', 'web:thread1', 'msg1', 'Recommend', [], blocked.llm);
    assert.match(blockedReply, locale === 'zh-CN' ? /没有足够证据/ : /not enough evidence/);
  });
}

test('English restriction reply does not perform candidate retrieval', async () => {
  const state = setup({ locale: 'en-US' });
  const llm = {
    generate: async () => {
      return {
        content: JSON.stringify({
          requestedCount: 5,
          softPreferences: [],
          recommendNow: true,
          question: null,
          genres: [],
          excludeGenres: [],
          referenceTitle: null,
          maxRuntime: null,
          language: null,
          unverifiableRestrictions: ['no gore'],
        }
        ),
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
  assert.match(
    await state.service.run('alice', 'web:thread1', 'msg1', 'Recommend', [], llm),
    /cannot reliably verify.*no gore/
  );
  assert.equal(state.queries(), 0);
});

function captureLogs() {
  const infos: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  const logger = {
    info: (fields: Record<string, unknown>) => infos.push(fields),
    error: (fields: Record<string, unknown>) => errors.push(fields),
  } as unknown as AiLogger;
  return { logger, infos, errors };
}

test('verbose recommendation stages reuse the parent correlation ID and omit raw input', async () => {
  const logs = captureLogs();
  const state = setup({ recommendNow: true, diagnostics: { logger: logs.logger, verbose: true } });
  const parent = new AiTrace(undefined, { requestId: 'request-123' }, 'private request');
  await withAiTrace(parent, () => state.service.run('alice', 'web:thread1', 'msg1', 'private request', [], state.llm));
  assert.ok(logs.infos.some((entry) => entry.stage === 'recommendation.plan.completed'));
  assert.ok(logs.infos.some((entry) => entry.stage === 'recommendation.discover.completed'));
  assert.ok(logs.infos.every((entry) => entry.correlationId === 'request-123'));
  assert.doesNotMatch(JSON.stringify(logs.infos), /private request|今天想看什么|符合战争题材要求/);
});

test('verbose=false keeps failure stage, original cause and stack while suppressing tracing', async () => {
  const logs = captureLogs();
  const state = setup({ diagnostics: { logger: logs.logger, verbose: false } });
  const cause = new Error('upstream unavailable');
  const error = new Error('model failed', { cause });
  await assert.rejects(
    state.service.run('alice', 'web:thread1', 'msg1', 'private request', [], {
      generate: async () => {
        throw error;
      },
    }
    ),
    (failure) => failure === error
  );
  assert.equal(logs.infos.length, 0);
  assert.equal(logs.errors.length, 1);
  assert.equal(logs.errors[0]?.stage, 'recommendation.plan');
  const diagnostic = logs.errors[0]?.error as { stack: string; cause: { message: string } };
  assert.equal(diagnostic.stack, error.stack);
  assert.equal(diagnostic.cause.message, cause.message);
});

test('lease cleanup failure preserves the original model error and logs both failures', async () => {
  const logs = captureLogs();
  const cleanupError = new Error('lease cleanup failed');
  const originalError = new Error('model unavailable');
  const state = setup({ releaseError: cleanupError, diagnostics: { logger: logs.logger, verbose: false } });
  await assert.rejects(
    state.service.run('alice', 'web:thread1', 'msg1', 'Recommend', [], {
      generate: async () => {
        throw originalError;
      },
    }
    ),
    (error) => error === originalError
  );
  assert.deepEqual(
    logs.errors.map((entry) => entry.stage),
    ['recommendation.plan', 'recommendation.lease.release']
  );
});

test('lease cleanup failure after successful execution is still propagated', async () => {
  const cleanupError = new Error('lease cleanup failed');
  const state = setup({ recommendNow: true, releaseError: cleanupError });
  await assert.rejects(
    state.service.run('alice', 'web:thread1', 'msg1', 'Recommend', [], state.llm),
    (error) => error === cleanupError
  );
});

test('clarification expires at thirty minutes despite fresh Mongo updatedAt after acquiring the lease', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-19T00:00:00Z') });
  const logs = captureLogs();
  const state = setup({ diagnostics: { logger: logs.logger, verbose: true } });
  for (let i = 1; i <= 3; i++) {
    await state.service.run('alice', 'web:thread1', `msg${i}`, `Old request ${i}`, [], state.llm);
  }
  assert.equal(state.data()?.questions, 3);
  t.mock.timers.tick(30 * 60_000 - 1);
  assert.equal(await state.service.active('alice', 'web:thread1'), true);
  t.mock.timers.tick(1);
  assert.equal(await state.service.active('alice', 'web:thread1'), false);

  const reply = await state.service.run('alice', 'web:thread1', 'msg4', 'New request', [], state.llm);
  assert.equal(reply, '今天想看什么？');
  assert.equal(state.queries(), 0);
  assert.equal(state.data()?.questions, 1);
  const plan = state.plans().at(-1)!;
  assert.equal(plan.questions, 0);
  assert.deepEqual(
    plan.conversation.map((message) => message.content),
    ['New request']
  );
  assert.equal(state.data()?.lastInteractionAt, '2026-10-19T00:30:00.000Z');
  assert.ok(logs.infos.some((entry) => entry.stage === 'recommendation.session.expired' && entry.outcome === 'reset'));
});

test('a new interaction within thirty minutes preserves progress and refreshes the continuation window', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-19T00:00:00Z') });
  const state = setup();
  await state.service.run('alice', 'web:thread1', 'msg1', 'First request', [], state.llm);
  t.mock.timers.tick(29 * 60_000);
  await state.service.run('alice', 'web:thread1', 'msg2', 'Second request', [], state.llm);
  assert.equal(state.data()?.questions, 2);
  assert.equal(state.plans().at(-1)?.questions, 1);
  assert.deepEqual(
    state
      .plans()
      .at(-1)
      ?.conversation.map((message) => message.content),
    ['First request', '今天想看什么？', 'Second request']
  );
  assert.equal(state.data()?.lastInteractionAt, '2026-10-19T00:29:00.000Z');
  t.mock.timers.tick(29 * 60_000);
  assert.equal(await state.service.active('alice', 'web:thread1'), true);
  t.mock.timers.tick(60_000);
  assert.equal(await state.service.active('alice', 'web:thread1'), false);
});

test('replaying a saved event does not refresh the interaction time or consume another clarification', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-19T00:00:00Z') });
  const state = setup();
  const reply = await state.service.run('alice', 'web:thread1', 'msg1', 'First request', [], state.llm);
  t.mock.timers.tick(31 * 60_000);
  assert.equal(await state.service.run('alice', 'web:thread1', 'msg1', 'First request', [], state.llm), reply);
  assert.equal(state.calls(), 1);
  assert.equal(state.data()?.questions, 1);
  assert.equal(state.data()?.lastInteractionAt, '2026-10-19T00:00:00.000Z');
  assert.equal(await state.service.active('alice', 'web:thread1'), false);
});

test('failed processing does not extend the continuation window or advance persisted progress', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-19T00:00:00Z') });
  const state = setup();
  await state.service.run('alice', 'web:thread1', 'msg1', 'First request', [], state.llm);
  t.mock.timers.tick(29 * 60_000);
  await assert.rejects(
    state.service.run('alice', 'web:thread1', 'msg2', 'Second request', [], {
      generate: async () => {
        throw new Error('upstream unavailable');
      },
    }
    ),
    /upstream unavailable/
  );
  assert.equal(state.data()?.questions, 1);
  assert.equal(state.data()?.lastInteractionAt, '2026-10-19T00:00:00.000Z');
  t.mock.timers.tick(60_000);
  assert.equal(await state.service.active('alice', 'web:thread1'), false);
});

for (const timestamp of [undefined, null, 'invalid', '2026-10-20T00:00:00Z']) {
  test(`legacy or invalid interaction time resets only clarification progress: ${timestamp}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-19T00:00:00Z') });
    const state = setup();
    const originalReply = await state.service.run('alice', 'web:thread1', 'msg1', 'Old request', [], state.llm);
    const data = state.data()!;
    if (timestamp === undefined) delete data.lastInteractionAt;
    else data.lastInteractionAt = timestamp;
    const batches = [{ id: 'previous-batch', movieIds: [99], profileVersion: 1, at: '2026-10-18T00:00:00Z' }];
    data.batches = batches;
    assert.equal(await state.service.active('alice', 'web:thread1'), false);
    await state.service.run('alice', 'web:thread1', 'msg2', 'New request', [], state.llm);
    assert.equal(state.plans().at(-1)?.questions, 0);
    assert.deepEqual(
      state
        .plans()
        .at(-1)
        ?.conversation.map((message) => message.content),
      ['New request']
    );
    assert.equal(state.data()?.questions, 1);
    assert.deepEqual(state.data()?.batches, batches);
    assert.equal((state.data()?.events as Record<string, string>).msg1, originalReply);
    assert.equal(await state.service.active('alice', 'web:thread1'), true);
  });
}

test('structured recommendations retain posters and replay without new model or TMDB calls', async () => {
  const state = setup({ recommendNow: true });
  const result = await state.service.runResult('alice', 'telegram:1', 'msg1', 'Recommend', [], state.llm);
  assert.deepEqual(result.movies, [
    { tmdbId: 3, title: 'Movie 3', reason: '符合战争题材要求', posterPath: '/poster.jpg' },
  ]);
  assert.match(result.replyText, /Movie 3/);
  const calls = state.calls();
  assert.deepEqual(await state.service.runResult('alice', 'telegram:1', 'msg1', 'Recommend', [], state.llm), result);
  assert.equal(state.calls(), calls);
  assert.equal(state.queries(), 2);
});

test('romance style preferences reach ranking without blocking TMDB and requested two caps an overlong ranking', async () => {
  const softPreferences = ['爱情和亲密关系的表达更大胆，不要太保守'];
  const state = setup({
    requestedCount: 2,
    softPreferences,
    question: null,
    genres: [10749],
    candidateIds: [3, 4, 5],
    rankedMovies: [3, 4, 5].map((tmdbId) => ({ tmdbId, reason: '影片简介支持浪漫关系题材，风格匹配存在不确定性' })),
  }
  );
  const result = await state.service.runResult(
    'alice',
    'telegram:1',
    'romance',
    '推荐两部浪漫爱情电影且影片不能太保守',
    [],
    state.llm
  );
  assert.equal(state.queries(), 2);
  assert.deepEqual(
    result.movies?.map((movie) => movie.tmdbId),
    [3, 4]
  );
  assert.equal(state.rankings()[0]?.requestedCount, 2);
  assert.deepEqual(state.rankings()[0]?.softPreferences, softPreferences);
  assert.deepEqual(state.filters()[0], { genres: [10749], excludeGenres: [], maxRuntime: null, language: null });
  assert.doesNotMatch(result.replyText, /无法可靠核实|Movie 5/);
  const calls = state.calls();
  assert.deepEqual(
    await state.service.runResult(
      'alice',
      'telegram:1',
      'romance',
      '推荐两部浪漫爱情电影且影片不能太保守',
      [],
      state.llm
    ),
    result
  );
  assert.equal(state.calls(), calls);
});

for (const requestedCount of [1, 5]) {
  test(`workflow enforces requested count ${requestedCount} for text and media recommendations`, async () => {
    const state = setup({
      requestedCount,
      question: null,
      candidateIds: [3, 4, 5, 6, 7],
      rankedMovies: [3, 4, 5, 6, 7].map((tmdbId) => ({ tmdbId, reason: 'Matches the request' })),
    }
    );
    const result = await state.service.runResult('alice', 'whatsapp:1', 'count', 'Recommend movies', [], state.llm);
    assert.equal(result.movies?.length, requestedCount);
    assert.equal((result.replyText.match(/https:\/\/www.themoviedb.org\/movie\//g) ?? []).length, requestedCount);
  });
}

test('requested count is applied after deduplication and the latest watched-state check', async () => {
  const state = setup({
    requestedCount: 2,
    question: null,
    candidateIds: [3, 4, 5],
    rankedMovies: [3, 3, 4, 5].map((tmdbId) => ({ tmdbId, reason: 'Matches the request' })),
  }
  );
  state.blockOnRecheck();
  const result = await state.service.runResult('alice', 'telegram:1', 'count', 'Recommend two', [], state.llm);
  assert.deepEqual(
    result.movies?.map((movie) => movie.tmdbId),
    [4, 5]
  );
});

test('too few eligible movies are returned without padding and the shortfall is logged without preferences', async () => {
  const logs = captureLogs();
  const state = setup({
    requestedCount: 2,
    question: null,
    softPreferences: ['private subjective taste'],
    diagnostics: { logger: logs.logger, verbose: true },
  }
  );
  const result = await state.service.runResult('alice', 'telegram:1', 'count', 'Recommend two', [], state.llm);
  assert.equal(result.movies?.length, 1);
  assert.ok(
    logs.infos.some((entry) => {
      return (
        entry.stage === 'recommendation.selection.completed'
        && entry.requestedCount === 2
        && entry.selectedCount === 1
        && entry.outcome === 'shortfall'
      );
    })
  );
  assert.doesNotMatch(JSON.stringify(logs), /private subjective taste/);
});

test('resolved per-turn locale reaches recommendation planning, ranking and fixed replies without changing the tool default', async () => {
  const empty = setup({ locale: 'zh-CN', noCandidates: true, recommendNow: true, question: null });
  const english = await empty.service.runResult('alice', 'web:thread', 'en', 'Recommend now', [], empty.llm, 'en-US');
  assert.match(english.replyText, /No movies matched/);
  assert.equal(empty.plans().at(-1)?.responseLocale, 'en-US');
  const chinese = await empty.service.runResult('alice', 'web:thread', 'zh', '直接推荐', [], empty.llm);
  assert.match(chinese.replyText, /本次没有找到/);
  assert.equal(empty.plans().at(-1)?.responseLocale, 'zh-CN');
  const ranked = setup({ locale: 'zh-CN', recommendNow: true, question: null });
  await ranked.service.runResult('alice', 'web:thread', 'rank-en', 'Recommend now', [], ranked.llm, 'en-US');
  assert.equal(ranked.rankings().at(-1)?.responseLocale, 'en-US');
});
