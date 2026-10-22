import assert from 'node:assert/strict';
import test from 'node:test';
import { TmdbClient } from './client.js';
import type { ExternalRequestEventInput } from '../../modules/external-usage/external-usage.types.js';

const responseBody = { page: 1, results: [{ id: 42, title: 'Movie' }], total_pages: 1, total_results: 1 };

test('uses a v3 API key as an api_key query parameter', async () => {
  let requestedUrl = '';
  let authorization: string | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get('authorization');
    return Response.json(responseBody);
  };
  await new TmdbClient('0123456789abcdef0123456789abcdef', 1_000, 'https://example.test/3', fetcher).fetchPage(
    1,
    'zh-CN'
  );
  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get('api_key'), '0123456789abcdef0123456789abcdef');
  assert.equal(authorization, null);
});

test('uses a v4 read access token as a bearer credential', async () => {
  let requestedUrl = '';
  let authorization: string | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get('authorization');
    return Response.json(responseBody);
  };
  await new TmdbClient('eyJ.example-token', 1_000, 'https://example.test/3', fetcher).fetchPage(1, 'zh-CN');
  assert.equal(new URL(requestedUrl).searchParams.has('api_key'), false);
  assert.equal(authorization, 'Bearer eyJ.example-token');
});

test('maps movie details, the best YouTube trailer, directors, and only the first twenty cast members', async () => {
  const cast = Array.from({ length: 22 }, (_, index) => {
    return {
      id: index + 1,
      credit_id: `cast-${index}`,
      name: `Actor ${index}`,
      character: `Role ${index}`,
      order: index,
    };
  });
  const fetcher: typeof fetch = async () => {
    return Response.json({
      id: 42,
      title: '电影',
      original_title: 'Movie',
      overview: 'Story',
      release_date: '2026-10-12',
      imdb_id: 'tt0000042',
      runtime: 125,
      tagline: 'Tagline',
      genres: [{ id: 18, name: '剧情' }],
      videos: {
        results: [
          {
            id: 'featurette',
            key: 'featurette_1',
            name: 'Behind the scenes',
            site: 'YouTube',
            type: 'Featurette',
            official: true,
          },
          {
            id: 'english',
            key: 'english_key',
            name: 'English trailer',
            site: 'YouTube',
            type: 'Trailer',
            iso_639_1: 'en',
            official: true,
            published_at: '2026-10-12T00:00:00.000Z',
          },
          {
            id: 'chinese-unofficial',
            key: 'zh_old_key',
            name: '旧中文预告',
            site: 'YouTube',
            type: 'Trailer',
            iso_639_1: 'zh',
            official: false,
            published_at: '2026-10-10T00:00:00.000Z',
          },
          {
            id: 'chinese-official',
            key: 'zh_new_key',
            name: '官方中文预告',
            site: 'YouTube',
            type: 'Trailer',
            iso_639_1: 'zh',
            iso_3166_1: 'CN',
            official: true,
            published_at: '2026-10-11T00:00:00.000Z',
          },
        ],
      },
      credits: {
        cast,
        crew: [
          { id: 99, credit_id: 'director-1', name: 'Director', job: 'Director' },
          { id: 100, credit_id: 'writer-1', name: 'Writer', job: 'Writer' },
        ],
      },
    }
    );
  };
  const detail = await new TmdbClient('eyJ.token', 1_000, 'https://example.test/3', fetcher).fetchDetails(42, 'zh-CN');
  assert.equal(detail.imdbId, 'tt0000042');
  assert.equal(detail.runtimeMinutes, 125);
  assert.deepEqual(detail.trailer, {
    tmdbVideoId: 'chinese-official',
    provider: 'youtube',
    providerVideoId: 'zh_new_key',
    name: '官方中文预告',
    language: 'zh',
    region: 'CN',
    official: true,
    publishedAt: new Date('2026-10-11T00:00:00.000Z'),
  }
  );
  assert.deepEqual(detail.genres, [{ tmdbId: 18, name: '剧情' }]);
  assert.equal(detail.cast.length, 20);
  assert.deepEqual(
    detail.directors.map(({ person }) => person.name),
    ['Director']
  );
});

test('requests translations but maps only the explicitly requested locale', async () => {
  let requestedUrl = '';
  const fetcher: typeof fetch = async (input) => {
    requestedUrl = String(input);
    return Response.json({
      id: 42,
      title: 'Top-level fallback',
      overview: 'Top-level overview',
      genres: [],
      credits: {},
      translations: {
        translations: [
          {
            iso_639_1: 'en',
            iso_3166_1: 'US',
            data: { title: 'English title', overview: 'English overview', tagline: 'English tagline' },
          },
          { iso_639_1: 'zh', iso_3166_1: 'CN', data: { title: '中文标题', overview: '中文简介', tagline: '中文标语' } },
        ],
      },
    }
    );
  };

  const detail = await new TmdbClient('eyJ.token', 1_000, 'https://example.test/3', fetcher).fetchDetails(42, 'zh-CN');

  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get('language'), 'zh-CN');
  assert.equal(url.searchParams.get('append_to_response'), 'credits,translations,videos');
  assert.equal(url.searchParams.get('include_video_language'), 'zh,en,null');
  assert.equal(detail.title, '中文标题');
  assert.equal(detail.overview, '中文简介');
  assert.equal(detail.tagline, '中文标语');
});

test('ignores non-YouTube videos and unsafe YouTube keys', async () => {
  const fetcher: typeof fetch = async () => {
    return Response.json({
      id: 42,
      title: 'Movie',
      genres: [],
      credits: {},
      videos: {
        results: [
          { id: 'vimeo', key: '1234', name: 'Trailer', site: 'Vimeo', type: 'Trailer', official: true },
          { id: 'unsafe', key: 'bad/key', name: 'Trailer', site: 'YouTube', type: 'Trailer', official: true },
        ],
      },
    }
    );
  };
  const detail = await new TmdbClient('eyJ.token', 1_000, 'https://example.test/3', fetcher).fetchDetails(42, 'en-US');
  assert.equal(detail.trailer, undefined);
});

test('uses TMDB top-level fallback when the requested detail translation is missing', async () => {
  const fetcher: typeof fetch = async () => {
    return Response.json({
      id: 42,
      title: 'Original title',
      overview: 'Original overview',
      genres: [],
      credits: {},
      translations: { translations: [{ iso_639_1: 'en', iso_3166_1: 'US', data: { title: 'English title' } }] },
    }
    );
  };

  const detail = await new TmdbClient('eyJ.token', 1_000, 'https://example.test/3', fetcher).fetchDetails(42, 'zh-CN');
  assert.equal(detail.title, 'Original title');
  assert.equal(detail.overview, 'Original overview');
});

test('records every real TMDB retry with user attribution', async () => {
  const events: ExternalRequestEventInput[] = [];
  let attempts = 0;
  const fetcher: typeof fetch = async () => {
    attempts += 1;
    return attempts === 1
      ? new Response(null, { status: 429, headers: { 'retry-after': '0' } })
      : Response.json(responseBody);
  };
  const client = new TmdbClient('eyJ.token', 1_000, 'https://example.test/3', fetcher, {
    record: async (event) => {
      events.push(event);
    },
  });

  await client.fetchPage(1, 'zh-CN', { actorType: 'user', ownerId: 'owner-1', trigger: 'api_request' });

  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map(({ outcome, attempt, trigger, httpStatus, errorCode }) => {
      return {
        outcome,
        attempt,
        trigger,
        httpStatus,
        errorCode,
      };
    }),
    [
      { outcome: 'failure', attempt: 1, trigger: 'api_request', httpStatus: 429, errorCode: 'rate_limited' },
      { outcome: 'success', attempt: 2, trigger: 'retry', httpStatus: 200, errorCode: undefined },
    ]
  );
  assert.equal(events[0]?.operationId, events[1]?.operationId);
  assert.equal(events[0]?.ownerId, 'owner-1');
  assert.equal(events[0]?.operation, 'movie.trending');
});
