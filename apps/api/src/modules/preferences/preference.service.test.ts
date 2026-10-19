import assert from 'node:assert/strict';
import test from 'node:test';
import { PreferenceService } from './preference.service.js';
import { emptyProfile } from './preference.domain.js';
import type { MongoPreferenceStore } from '../../infrastructure/mongodb/preferences/preference.store.js';
import type { MovieCatalogStore, MovieSearchProvider, MovieStatusRecord, MovieStatusStore } from '../movies/movie.types.js';

function setup(count: number) {
  let profile = emptyProfile();
  const queued: unknown[][] = [];
  let modelCalls = 0;
  const rows: MovieStatusRecord[] = Array.from({ length: count }, (_, i) => {
    return { tmdbId: i + 1, status: 'watched', preference: i % 2 ? 'liked' : 'disliked', updatedAt: new Date() };
  });
  const store = {
    read: async () => structuredClone(profile),
    latest: async () => null,
    enqueue: async (...args: unknown[]) => {
      queued.push(args);
    },
    save: async (_owner: string, version: number, next: typeof profile) => {
      if (version !== profile.version) return false;
      profile = next;
      return true;
    },
    cancel: async () => {},
  } as unknown as MongoPreferenceStore;
  const statuses = {
    list: async (ownerId: string) => {
      assert.equal(ownerId, 'alice');
      return { items: rows, total: rows.length };
    },
  } as unknown as MovieStatusStore;
  const service = new PreferenceService(
    store,
    statuses,
    {} as MovieCatalogStore,
    {} as MovieSearchProvider,
    'zh-CN',
    async () => {
      modelCalls++;
    },
  );
  return { service, queued, rows, profile: () => profile, modelCalls: () => modelCalls };
}
test('first manual generation requires five distinct explicit movie ratings; watched-only is insufficient', async () => {
  const state = setup(4);
  state.rows.push({ tmdbId: 9, status: 'watched', preference: 'neutral', updatedAt: new Date() });
  await assert.rejects(state.service.generate('alice'), /five/);
  assert.equal(state.queued.length, 0);
  assert.equal(state.modelCalls(), 0);
});
test('manual generation enqueues evidence without waiting for TMDB or model generation', async () => {
  const state = setup(5);
  await state.service.generate('alice');
  assert.equal(state.queued.length, 1);
  assert.equal(state.queued[0]?.[2], 'manual');
  assert.equal((state.queued[0]?.[3] as unknown[]).length, 5);
});
test('chat updates obey the automatic maintenance toggle, and stale user edits cannot overwrite data', async () => {
  const state = setup(5);
  await state.service.edit('alice', 0, { autoMaintain: false });
  await state.service.chatEvidence('alice', 'msg1', '我一直喜欢历史片', []);
  assert.equal(state.queued.length, 0);
  await assert.rejects(state.service.edit('alice', 0, { autoMaintain: true }), /Reload/);
  assert.equal(state.profile().autoMaintain, false);
});
test('manual corrections become protected explicit entries; deletion preserves withdrawal evidence', async () => {
  const state = setup(5);
  state
    .profile()
    .entries.push({
      id: 'p1',
      content: '可能喜欢诺兰',
      section: 'inferred',
      evidenceRefs: ['movie:1:liked'],
      protected: false,
      updatedAt: new Date().toISOString(),
    }
  );
  await state.service.edit('alice', 0, { entryId: 'p1', content: '我更喜欢历史题材' });
  assert.equal(state.profile().entries[0]?.section, 'explicit');
  assert.equal(state.profile().entries[0]?.protected, true);
  assert.ok(state.profile().withdrawn.includes('movie:1:liked'));
  await state.service.edit('alice', 1, { clear: true });
  assert.equal(state.profile().entries.length, 0);
  assert.equal(state.profile().autoMaintain, false);
});
test('regeneration remains available after ratings drop below the initial gate', async () => {
  const state = setup(3);
  state.profile().generatedAt = new Date().toISOString();
  await state.service.generate('alice');
  assert.equal(state.queued.length, 1);
});

test('manual generation fits 35 multilingual movie samples within the context budget without full catalog documents', async () => {
  const { PreferenceAgent } = await import('./agents/preference.agent.js');
  const { Utf8ByteTokenCounter } = await import('../llm/utf8-byte-token-counter.js');
  const state = setup(35);
  for (const row of state.rows.slice(-5)) row.preference = 'neutral';
  await state.service.generate('alice');
  const evidence = state.queued[0]?.[3] as import('./preference.types.js').PreferenceEvidence[];
  const largeOverview = '这是一段非常长的电影简介。'.repeat(1500);
  const movies = state.rows.map((row) => {
    return {
      tmdbId: row.tmdbId,
      title: `历史战争电影 ${row.tmdbId}`,
      genreIds: [18, 10752],
      overview: largeOverview,
      posterPath: '/UNNECESSARY_IMAGE.jpg',
      voteCount: 12345,
      genres: [
        { tmdbId: 18, name: '剧情' },
        { tmdbId: 10752, name: '战争' },
      ],
      directors: [{ person: { name: '克里斯托弗·诺兰' } }],
      cast: Array.from({ length: 10 }, (_, index) => ({ person: { name: `演员 ${index}` } })),
    };
  });
  const service = new PreferenceService(
    state.service.store,
    {
      list: async () => {
        return { items: state.rows, total: state.rows.length };
      },
    } as unknown as MovieStatusStore,
    {
      readMovies: async () => {
        return movies;
      },
      readMovieDetail: async (id: number) => {
        return movies.find((movie) => movie.tmdbId === id);
      },
    } as unknown as MovieCatalogStore,
    {} as MovieSearchProvider,
    'zh-CN',
    async () => {},
  );
  const job = {
    id: 'manual-job',
    ownerId: 'alice',
    kind: 'manual' as const,
    evidence,
    attempts: 1,
    fingerprint: state.queued[0]?.[4] as string,
    leaseId: 'lease',
  };
  const enriched = await service.enrich(job);
  assert.equal(enriched.evidence.length, 35);
  assert.deepEqual(
    enriched.evidence.map((item) => item.ref),
    evidence.map((item) => item.ref),
  );
  for (const item of enriched.evidence) {
    const record = JSON.parse(item.text);
    assert.ok(record.preference && record.status && record.title);
    assert.deepEqual(record.directors, ['克里斯托弗·诺兰']);
    assert.equal(record.cast.length, 5);
    assert.equal(record.overview, undefined);
    assert.equal(record.posterPath, undefined);
    assert.equal(record.voteCount, undefined);
  }
  let request: import('../llm/llm.types.js').LlmGenerateInput | undefined;
  const agent = new PreferenceAgent(async () => {
    return {
      generate: async (input) => {
        request = input;
        return { content: '{"changes":[]}', inputTokens: 1, outputTokens: 1 };
      },
    };
  });
  await agent.run(enriched, emptyProfile(), new AbortController().signal);
  assert.ok(request);
  const counter = new Utf8ByteTokenCounter();
  const total =
    request.messages.reduce((sum, message) => sum + counter.count(message.content) + 4, 256) + request.maxOutputTokens;
  assert.ok(total <= 32_000, `Context including reserved output must fit: ${total}`);
  assert.ok(!JSON.stringify(request).includes('UNNECESSARY_IMAGE'));
});
