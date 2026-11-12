import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions, request as httpsRequest } from 'node:https';
import {
  MTeamClient,
  classifyMTeamHttpFailure,
  createPinnedLookup,
  isPublicAddress,
  parseSearchReleases,
  parseSearchPage,
  resolvePublicAddresses,
  verificationUrl,
  withAbsoluteTimeout,
  requestBytes,
} from './client.js';

function transportFixture(hops: number, status = 302, location?: string) {
  const seen: Array<{ url: URL; options: RequestOptions; body: string | undefined }> = [];
  const transport = ((url: URL, options: RequestOptions, respond: (response: IncomingMessage) => void) => {
    const request = new EventEmitter();
    Object.assign(request, { end(body?: string) {
      seen.push({ url, options, body });
      queueMicrotask(() => {
        const response = new PassThrough();
        const redirect = seen.length <= hops;
        Object.assign(response, { statusCode: redirect ? status : 200,
          headers: redirect ? { location: location ?? `/hop-${seen.length}` } : {} });
        respond(response as unknown as IncomingMessage);
        response.end(redirect ? '' : 'ok');
      });
    } });
    return request;
  }) as unknown as typeof httpsRequest;
  return { transport, seen };
}

test('M-Team follows five same-origin redirects with pinned DNS and stops before a sixth hop', async () => {
  for (const hops of [5, 6]) {
    const f = transportFixture(hops);
    const signal = new AbortController().signal;
    const result = requestBytes(new URL('https://api.m-team.cc/api/start'), { address: '1.1.1.1', family: 4 }, signal, 1024,
      { method: 'POST', headers: { 'x-api-key': 'PRIVATE', 'content-type': 'application/json', 'content-length': 2 } }, '{}', f.transport);
    if (hops === 5) assert.equal((await result).toString(), 'ok');
    else await assert.rejects(result, { failureType: 'remote_error' });
    assert.equal(f.seen.length, 6);
    assert.ok(f.seen.every((r) => r.options.signal === signal && r.options.lookup));
    assert.ok(f.seen.every((r) => (r.options.headers as Record<string, string>)['x-api-key'] === 'PRIVATE'));
  }
});

test('M-Team redirect statuses replay POST bodies only for 307 and 308', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const f = transportFixture(1, status);
    await requestBytes(new URL('https://api.m-team.cc/api/start'), { address: '1.1.1.1', family: 4 }, new AbortController().signal, 1024,
      { method: 'POST', headers: { 'x-api-key': 'PRIVATE', 'content-type': 'application/json', 'content-length': 2 } }, '{}', f.transport);
    assert.equal(f.seen[1]!.options.method, status === 307 || status === 308 ? 'POST' : 'GET');
    assert.equal(f.seen[1]!.body, status === 307 || status === 308 ? '{}' : undefined);
  }
});

test('M-Team never forwards the API Key to a foreign origin or follows login and looping redirects', async () => {
  for (const location of ['https://foreign.example/api', '/login', '/api/start', 'http://api.m-team.cc/api', '/file#PRIVATE']) {
    const f = transportFixture(1, 302, location);
    await assert.rejects(requestBytes(new URL('https://api.m-team.cc/api/start'), { address: '1.1.1.1', family: 4 }, new AbortController().signal, 1024,
      { method: 'POST', headers: { 'x-api-key': 'PRIVATE' } }, '{}', f.transport));
    assert.equal(f.seen.length, 1);
  }
});

test('uses the authenticated M-Team endpoint that requires no request parameters', () => {
  assert.equal(verificationUrl('https://api.m-team.cc').href, 'https://api.m-team.cc/api/member/profile');
  assert.equal(verificationUrl('https://api.m-team.cc/api').href, 'https://api.m-team.cc/api/member/profile');
});

test('rejects loopback, private, link-local, carrier NAT, documentation, and multicast addresses', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.1.1',
    '100.64.0.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('rejects a literal private address before making a request', async () => {
  await assert.rejects(resolvePublicAddresses('127.0.0.1'), /Private network addresses/);
});

test('pinned lookup follows the Node callback shape for single and all-address requests', async () => {
  const pinned = createPinnedLookup({ address: '1.1.1.1', family: 4 });
  const single = await new Promise<{ address: string | object[]; family: number | undefined }>((resolve, reject) => {
    pinned('api.m-team.cc', { all: false }, (error, address, family) => {
      return error ? reject(error) : resolve({ address, family });
    });
  });
  assert.deepEqual(single, { address: '1.1.1.1', family: 4 });

  const all = await new Promise<{ address: string | object[]; family: number | undefined }>((resolve, reject) => {
    pinned('api.m-team.cc', { all: true }, (error, address, family) => {
      return error ? reject(error) : resolve({ address, family });
    });
  });
  assert.deepEqual(all, { address: [{ address: '1.1.1.1', family: 4 }], family: undefined });
});

test('absolute validation timeout rejects even when the underlying operation never settles', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    withAbsoluteTimeout(20, async () => new Promise<never>(() => undefined)),
    (error: unknown) => {
      return (
        error instanceof Error
        && error.name === 'IntegrationValidationError'
        && 'failureType' in error
        && error.failureType === 'timeout'
      );
    });
  assert.ok(Date.now() - startedAt < 500);
});

test('parses the M-Team movie search fields used by availability checks', () => {
  assert.deepEqual(
    parseSearchReleases({
      code: 0,
      data: {
        data: [
          {
            id: '991',
            name: 'The.Matrix.1999.2160p.UHD.BluRay',
            size: '2147483648',
            createdDate: '2026-10-13 08:30:00',
            imdb: 'https://www.imdb.com/title/tt0133093/',
            standard: '6',
            medium: '3',
            videoCodec: '16',
            audioCodec: '11',
            labelsNew: ['中字', 'DoVi'],
            status: { visible: true, banned: false, seeders: '12', leechers: '4', discount: 'FREE' },
          },
        ],
      },
    }
    ),
    [
      {
        id: '991',
        title: 'The.Matrix.1999.2160p.UHD.BluRay',
        imdbId: 'tt0133093',
        visible: true,
        banned: false,
        seeders: 12,
        leechers: 4,
        sizeBytes: 2147483648,
        publishedAt: '2026-10-13 08:30:00',
        discount: 'FREE',
        resolution: '4K',
        medium: 'Remux',
        videoCodec: 'H.265',
        audioCodec: 'DTS-HD MA',
        tags: ['中字', 'DoVi'],
      },
    ]
  );
});

test('rejects a search response that cannot prove visibility or seeder count', () => {
  assert.throws(() => {
    return parseSearchReleases({
      code: 0,
      data: { data: [{ imdb: 'tt0133093', status: { visible: true, banned: false } }] },
    }
    );
  }, /invalid search response/
  );
});

test('classifies rate limiting separately while sanitizing other upstream server failures', () => {
  assert.equal(classifyMTeamHttpFailure(401), 'authentication');
  assert.equal(classifyMTeamHttpFailure(403), 'permission');
  assert.equal(classifyMTeamHttpFailure(429), 'rate_limited');
  assert.equal(classifyMTeamHttpFailure(500), 'remote_error');
});

test('search client records terminal pre-HTTP errors once with attempt metadata and safe standalone diagnostics', async () => {
  const events: Array<{ attempt: number; operationId: string; outcome: string }> = [];
  const errors: Record<string, unknown>[] = [];
  const infos: unknown[] = [];
  const client = new MTeamClient(
    100,
    {
      record: async (event) => {
        events.push(event);
      },
    },
    {
      minimumIntervalMs: 0,
      verbose: false,
      logger: {
        error: (entry: Record<string, unknown>) => {
          return errors.push(entry);
        },
        info: (entry: Record<string, unknown>) => {
          return infos.push(entry);
        },
      },
    }
  );
  await assert.rejects(
    client.searchMovies(
      'https://127.0.0.1',
      'private-api-key',
      { title: 'private movie query' },
      {
        actorType: 'user',
        ownerId: 'alice',
        trigger: 'api_request',
      }
    ),
    /Private network addresses/
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.attempt, 1);
  assert.equal(events[0]?.outcome, 'failure');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.ownerId, 'alice');
  assert.ok(errors[0]?.correlationId);
  assert.equal(infos.length, 0);
  assert.doesNotMatch(JSON.stringify(errors), /private-api-key|private movie query/);
});

test('absolute request timeout respects parent cancellation and keeps its original reason', async () => {
  const controller = new AbortController();
  const reason = new Error('parent query cancelled');
  const work = withAbsoluteTimeout(
    1000,
    async () => {
      controller.abort(reason);
      return new Promise<never>(() => undefined);
    },
    { signal: controller.signal }
  );
  await assert.rejects(work, (error) => error === reason);
  await assert.rejects(
    withAbsoluteTimeout(1000, async () => 'must not execute', {
      signal: AbortSignal.abort(reason),
    }),
    (error) => error === reason
  );
});

test('M-Team pagination uses total metadata and caps native pages at 100', () => {
  assert.deepEqual(parseSearchPage({ data: { data: [], total: '250' } }, 2), { releases: [], nextPage: 3 });
  assert.deepEqual(parseSearchPage({ data: { data: [], total: '250' } }, 3), { releases: [] });
  assert.deepEqual(parseSearchPage({ data: { data: [], total: 20000 } }, 100), { releases: [] });
});

test('extracts M-Team release groups from titles while retaining structured codecs', () => {
  const releases = parseSearchReleases({
    data: [
      {
        id: '99',
        name: 'Movie.2026.1080p.WEB-DL.H264-TURG',
        videoCodec: '16',
        status: { visible: true, banned: false, seeders: 1 },
      },
    ],
  }
  );
  assert.equal(releases[0]?.releaseGroup, 'TURG');
  assert.equal(releases[0]?.videoCodec, 'H.265');
});
