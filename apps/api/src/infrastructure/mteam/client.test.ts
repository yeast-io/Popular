import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPinnedLookup, isPublicAddress, parseSearchReleases, resolvePublicAddresses, verificationUrl, withAbsoluteTimeout,
} from './client.js';

test('uses the authenticated M-Team endpoint that requires no request parameters', () => {
  assert.equal(verificationUrl('https://api.m-team.cc').href, 'https://api.m-team.cc/api/member/sysRoleList');
  assert.equal(verificationUrl('https://api.m-team.cc/api').href, 'https://api.m-team.cc/api/member/sysRoleList');
});

test('rejects loopback, private, link-local, carrier NAT, documentation, and multicast addresses', () => {
  for (const address of [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1',
    '100.64.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
    '::', '::1', 'fc00::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1',
  ]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('rejects a literal private address before making a request', async () => {
  await assert.rejects(resolvePublicAddresses('127.0.0.1'), /Private network addresses/);
});

test('pinned lookup follows the Node callback shape for single and all-address requests', async () => {
  const pinned = createPinnedLookup({ address: '1.1.1.1', family: 4 });
  const single = await new Promise<{ address: string | object[]; family: number | undefined }>((resolve, reject) => {
    pinned('api.m-team.cc', { all: false }, (error, address, family) => error ? reject(error) : resolve({ address, family }));
  });
  assert.deepEqual(single, { address: '1.1.1.1', family: 4 });

  const all = await new Promise<{ address: string | object[]; family: number | undefined }>((resolve, reject) => {
    pinned('api.m-team.cc', { all: true }, (error, address, family) => error ? reject(error) : resolve({ address, family }));
  });
  assert.deepEqual(all, { address: [{ address: '1.1.1.1', family: 4 }], family: undefined });
});

test('absolute validation timeout rejects even when the underlying operation never settles', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    withAbsoluteTimeout(20, async () => new Promise<never>(() => undefined)),
    (error: unknown) => error instanceof Error && error.name === 'IntegrationValidationError' && 'failureType' in error && error.failureType === 'timeout',
  );
  assert.ok(Date.now() - startedAt < 500);
});

test('parses the M-Team movie search fields used by availability checks', () => {
  assert.deepEqual(parseSearchReleases({
    code: 0,
    data: {
      data: [{
        imdb: 'https://www.imdb.com/title/tt0133093/',
        status: { visible: true, banned: false, seeders: '12' },
      }],
    },
  }), [{ imdbId: 'tt0133093', visible: true, banned: false, seeders: 12 }]);
});

test('rejects a search response that cannot prove visibility or seeder count', () => {
  assert.throws(() => parseSearchReleases({
    code: 0,
    data: { data: [{ imdb: 'tt0133093', status: { visible: true, banned: false } }] },
  }), /invalid search response/);
});
