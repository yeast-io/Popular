import assert from 'node:assert/strict';
import test from 'node:test';
import { MTeamClient, classifyMTeamHttpFailure, createPinnedLookup, isPublicAddress, parseSearchReleases, resolvePublicAddresses, verificationUrl, withAbsoluteTimeout } from './client.js';

test('uses the authenticated M-Team endpoint that requires no request parameters', () => {
  assert.equal(verificationUrl('https://api.m-team.cc').href, 'https://api.m-team.cc/api/member/sysRoleList');
  assert.equal(verificationUrl('https://api.m-team.cc/api').href, 'https://api.m-team.cc/api/member/sysRoleList');
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
    },
    );
  });
  assert.deepEqual(single, { address: '1.1.1.1', family: 4 });

  const all = await new Promise<{ address: string | object[]; family: number | undefined }>((resolve, reject) => {
    pinned('api.m-team.cc', { all: true }, (error, address, family) => {
      return error ? reject(error) : resolve({ address, family });
    },
    );
  });
  assert.deepEqual(all, { address: [{ address: '1.1.1.1', family: 4 }], family: undefined });
});

test('absolute validation timeout rejects even when the underlying operation never settles', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    withAbsoluteTimeout(20, async () => new Promise<never>(() => undefined)),
    (error: unknown) => {
      return (
        error instanceof Error &&
        error.name === 'IntegrationValidationError' &&
        'failureType' in error &&
        error.failureType === 'timeout'
      );
    },
  );
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
    ],
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
  const client = new MTeamClient(100, { record: async (event) => { events.push(event); } }, {
    minimumIntervalMs: 0, verbose: false,
    logger: { error: (entry: Record<string, unknown>) => {
      return errors.push(entry);
    }, info: (entry: Record<string, unknown>) => {
      return infos.push(entry);
    } },
  });
  await assert.rejects(client.searchMovies('https://127.0.0.1', 'private-api-key', { title: 'private movie query' }, {
    actorType: 'user', ownerId: 'alice', trigger: 'api_request',
  }
  ), /Private network addresses/
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
  const work = withAbsoluteTimeout(1000, async () => {
    controller.abort(reason);
    return new Promise<never>(() => undefined);
  }, { signal: controller.signal }
  );
  await assert.rejects(work, (error) => error === reason);
  await assert.rejects(withAbsoluteTimeout(1000, async () => 'must not execute', {
    signal: AbortSignal.abort(reason),
  }), (error) => error === reason
  );
});
