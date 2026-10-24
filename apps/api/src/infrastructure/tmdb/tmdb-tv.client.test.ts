import assert from 'node:assert/strict';
import test from 'node:test';
import { TmdbHttpClient } from './tmdb-http.client.js';
import { TmdbTvClient } from './tmdb-tv.client.js';
import { AiTrace, withAiTrace } from '../logging/ai-trace.js';

const context = { actorType: 'anonymous' as const, trigger: 'api_request' as const };
const summary = { id: 42, name: '电视剧', original_name: 'Series', poster_path: '/poster.jpg', first_air_date: '2025-03-01' };
const season = { id: 99, name: 'Season 1', season_number: 1, episode_count: 1 };
const episode = { id: 100, show_id: 42, name: 'Pilot', season_number: 1, episode_number: 1, overview: 'Full story', still_path: '/still.jpg', runtime: 45 };
const client = (payload: unknown) => new TmdbTvClient(new TmdbHttpClient('token', 1000, async () => Response.json(payload)));
test('TV requests use TV endpoints, locale, auth, page and usage context', async () => {
  const calls: string[] = [];
  const usage: unknown[] = [];
  const http = new TmdbHttpClient('token', 1000, async (input, init) => {
    calls.push(String(input));
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
    assert.equal(init?.redirect, 'error');
    return Response.json({ page: 2, results: [summary], total_pages: 3, total_results: 50 });
  }, { record: async (event) => {
    usage.push(event);
  } });
  const response = await new TmdbTvClient(http).fetchTrending(2, 'zh-CN', context);
  assert.equal(response.items[0]?.mediaType, 'tv');
  assert.equal(response.items[0]?.name, '电视剧');
  assert.match(calls[0]!, /trending\/tv\/week\?language=zh-CN&page=2/);
  assert.equal((usage[0] as {
    operation: string;
  }).operation, 'tv.trending');
});
test('TV detail preserves absent counts and includes specials', async () => {
  const result = await client({ ...summary, genres: [], seasons: [{ ...season, season_number: 0, episode_count: null }] }).fetchDetail(42, 'en-US', context);
  assert.equal(result.numberOfSeasons, undefined);
  assert.equal(result.seasons?.[0]?.seasonNumber, 0);
  assert.equal(result.seasons?.[0]?.episodeCount, undefined);
});
test('season loads full episode overview, still image and runtime in one request', async () => {
  const result = await client({ ...season, episodes: [episode] }).fetchSeason(42, 1, 'en-US', context);
  assert.equal(result.episodeCount, 1);
  assert.equal(result.episodes?.[0]?.overview, 'Full story');
  assert.equal(result.episodes?.[0]?.runtimeMinutes, 45);
  assert.equal(result.episodes?.[0]?.stillPath, '/still.jpg');
});
test('rejects mismatched show, season, episode IDs and duplicate episode numbers', async () => {
  await assert.rejects(client({ ...summary, id: 41, genres: [], seasons: [] }).fetchDetail(42, 'en-US', context), /identity mismatch/);
  await assert.rejects(client({ ...season, season_number: 2, episodes: [] }).fetchSeason(42, 1, 'en-US', context), /season mismatch/);
  await assert.rejects(client({ ...season, episodes: [{ ...episode, show_id: 41 }] }).fetchSeason(42, 1, 'en-US', context), /identity mismatch/);
  await assert.rejects(client({ ...season, episodes: [episode, episode] }).fetchSeason(42, 1, 'en-US', context), /duplicate episode/);
});
test('rejects malformed counts, dates, images, missing episode arrays and mismatched pages', async () => {
  for (const payload of [{ ...season }, { ...season, episodes: [{ ...episode, runtime: -1 }] },
    { ...season, episodes: [{ ...episode, air_date: '2025-02-30' }] },
    { ...season, episodes: [{ ...episode, still_path: 'https://evil.example/p.jpg' }] }]) {
    await assert.rejects(client(payload).fetchSeason(42, 1, 'en-US', context));
  }
  await assert.rejects(client({ page: 2, total_pages: 3, total_results: 1, results: [] }).fetchTrending(1, 'en-US', context), /page mismatch/);
});
test('shared HTTP retries rate limits and records attempts without logging credentials', async () => {
  const events: unknown[] = [];
  let requests = 0;
  const secret = '0123456789abcdef0123456789abcdef';
  const http = new TmdbHttpClient(secret, 1000, async () => ++requests === 1 ? new Response(null, { status: 429, headers: { 'retry-after': '0' } }) : Response.json({}), {
    record: async (event) => {
      events.push(event);
    },
  });
  const logs: unknown[] = [];
  const trace = new AiTrace({ info: (value: unknown) => {
    logs.push(value);
  }, error: (value: unknown) => {
    logs.push(value);
  } }, { correlationId: 'test-id' }, '', 'tv.test', true);
  await withAiTrace(trace, () => http.request(new URL('https://example.test/tv'), 'tv.details', context));
  assert.equal(requests, 2);
  assert.equal(events.length, 2);
  assert.ok(!JSON.stringify(logs).includes(secret));
});
test('HTTP preserves network errors and verbose=false still logs redacted failure stacks', async () => {
  const logs: unknown[] = [];
  const secret = 'secret-token';
  const failure = new Error(`network failed ${secret}`, { cause: new Error('root cause') });
  const http = new TmdbHttpClient(secret, 1000, async () => {
    throw failure;
  });
  const trace = new AiTrace({ info: (value: unknown) => {
    logs.push(value);
  }, error: (value: unknown) => {
    logs.push(value);
  } }, { correlationId: 'quiet' }, '', 'tv.test', false);
  await withAiTrace(trace, async () => {
    await assert.rejects(http.request(new URL('https://example.test/tv'), 'tv.details', context), (error) => error === failure);
    trace.fail(failure);
  });
  assert.equal(logs.length, 1);
  const output = JSON.stringify(logs);
  assert.match(output, /root cause/);
  assert.match(output, /stack/);
  assert.ok(!output.includes(secret));
});

test('TV search encodes query, retains locale/page and validates the returned page', async () => {
  let requested: URL | undefined;
  const http = new TmdbHttpClient('token', 1000, async (input) => {
    requested = new URL(String(input));
    return Response.json({ page: 2, total_pages: 4, total_results: 70, results: [summary, summary] });
  });
  const response = await new TmdbTvClient(http).search('The Bear & Co', 2, 'zh-CN', context);
  assert.equal(requested?.pathname, '/3/search/tv');
  assert.equal(requested?.searchParams.get('query'), 'The Bear & Co');
  assert.equal(requested?.searchParams.get('language'), 'zh-CN');
  assert.equal(requested?.searchParams.get('page'), '2');
  assert.equal(requested?.searchParams.get('include_adult'), 'false');
  assert.equal(response.items.length, 1);
  await assert.rejects(client({ page: 1, total_pages: 3, total_results: 20, results: [] }).search('Series', 2, 'en-US', context), /page mismatch/);
});

test('TV details append videos, request language fallback and select a validated localized YouTube trailer', async () => {
  let requested: URL | undefined;
  const video = { id: 'english', key: 'Safe_video-1', name: 'Official trailer', site: 'YouTube', type: 'Trailer', official: true, iso_639_1: 'en', iso_3166_1: 'US', published_at: '2026-01-01T00:00:00.000Z' };
  const http = new TmdbHttpClient('token', 1000, async (input) => {
    requested = new URL(String(input));
    return Response.json({ ...summary, genres: [], seasons: [], videos: { results: [
      video, { ...video, id: 'zh', iso_639_1: 'zh', iso_3166_1: 'CN', name: '中文预告' },
      { ...video, id: 'invalid', key: 'bad?autoplay=0', iso_639_1: 'zh' },
      { ...video, id: 'teaser', type: 'Teaser', iso_639_1: 'zh' },
      { ...video, id: 'vimeo', site: 'Vimeo', iso_639_1: 'zh' },
    ] } });
  });
  const result = await new TmdbTvClient(http).fetchDetail(42, 'zh-CN', context);
  assert.equal(requested?.searchParams.get('append_to_response'), 'videos');
  assert.equal(requested?.searchParams.get('include_video_language'), 'zh,en,null');
  assert.equal(result.trailer?.tmdbVideoId, 'zh');
  assert.equal(result.trailer?.name, '中文预告');
  assert.equal(result.trailer?.providerVideoId, 'Safe_video-1');
  assert.equal(result.trailer?.publishedAt, '2026-01-01T00:00:00.000Z');
});
test('TV details without usable trailers remain valid and do not invent a trailer', async () => {
  const result = await client({ ...summary, genres: [], seasons: [], videos: { results: [{ site: 'YouTube', type: 'Clip' }, { key: 'bad/path' }] } }).fetchDetail(42, 'en-US', context);
  assert.equal(result.trailer, undefined);
});

for (const locale of ['en-US', 'zh-CN'] as const) {
  test(`TV detail preserves localized tagline and normalizes blank values (${locale})`, async () => {
    const tagline = locale === 'zh-CN' ? '真相即将揭晓' : 'The truth awaits';
    const result = await client({ ...summary, tagline: `  ${tagline}  `, genres: [], seasons: [] }).fetchDetail(42, locale, context);
    assert.equal(result.tagline, tagline);
    for (const value of [null, '', '   ']) {
      const empty = await client({ ...summary, tagline: value, genres: [], seasons: [] }).fetchDetail(42, locale, context);
      assert.equal(empty.tagline, undefined);
    }
  });
}
