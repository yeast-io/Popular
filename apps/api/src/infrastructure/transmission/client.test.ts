import assert from 'node:assert/strict';
import test from 'node:test';
import { TransmissionClient } from './client.js';
import { IntegrationValidationError } from '../../modules/integrations/integration.service.js';

const credential = { username: 'daniel', password: 'secret:with:colons' };
const success = () => Response.json({ result: 'success', arguments: { version: '4.0.6' }, tag: 1 });

test('uses the fixed RPC path, Basic auth and the 409 session handshake', async () => {
  const calls: { url: string; headers: Headers; body: unknown }[] = [];
  const client = new TransmissionClient(1000, async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    assert.equal(init?.redirect, 'manual');
    return calls.length === 1
      ? new Response(null, { status: 409, headers: { 'X-Transmission-Session-Id': 'session-one' } })
      : success();
  });
  assert.deepEqual(await client.verify('http://nas:9091', credential), { version: '4.0.6' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, 'http://nas:9091/transmission/rpc');
  assert.equal(
    calls[0]?.headers.get('authorization'),
    `Basic ${Buffer.from('daniel:secret:with:colons').toString('base64')}`,
  );
  assert.equal(calls[0]?.headers.get('x-transmission-session-id'), null);
  assert.equal(calls[1]?.headers.get('x-transmission-session-id'), 'session-one');
  assert.deepEqual(calls[1]?.body, { method: 'session-get', arguments: { fields: ['version'] }, tag: 1 });
});

test('negotiates JSON-RPC for new servers and does not reuse session IDs across calls', async () => {
  let calls = 0;
  const client = new TransmissionClient(1000, async (_url, init) => {
    calls++;
    const headers = new Headers(init?.headers);
    if (calls % 2 === 1) {
      assert.equal(headers.get('x-transmission-session-id'), null);
      return new Response(null, {
        status: 409,
        headers: {
          'X-Transmission-Session-Id': `session-${calls}`,
          'X-Transmission-Rpc-Version': '6.0.0',
        },
      });
    }
    assert.deepEqual(JSON.parse(String(init?.body)), {
      jsonrpc: '2.0',
      method: 'session_get',
      params: { fields: ['version'] },
      id: 1,
    }
    );
    assert.equal(headers.get('x-transmission-session-id'), `session-${calls - 1}`);
    return Response.json({ jsonrpc: '2.0', result: { version: '4.1.0' }, id: 1 });
  });
  await client.verify('http://nas:9091', credential);
  await client.verify('http://other:9091', { username: 'other', password: 'other-secret' });
  assert.equal(calls, 4);
});

test('rejects auth failures, redirects, malformed responses and bounded handshake failures', async () => {
  const cases: [() => Response, string][] = [
    [() => new Response(null, { status: 401 }), 'authentication'],
    [() => new Response(null, { status: 403 }), 'authentication'],
    [
      () => {
        return new Response(null, { status: 302, headers: { location: 'http://other' } });
      },
      'remote_error',
    ],
    [() => new Response(null, { status: 500 }), 'remote_error'],
    [() => new Response('<html>login</html>'), 'invalid_response'],
    [() => Response.json({ result: 'success', arguments: {} }), 'invalid_response'],
    [() => Response.json({ result: 'permission denied', tag: 1 }), 'invalid_response'],
    [() => new Response(null, { status: 409 }), 'invalid_response'],
    [
      () => {
        return new Response(null, { status: 409, headers: { 'X-Transmission-Session-Id': 'always-expired' } });
      },
      'invalid_response',
    ],
  ];
  for (const [response, failureType] of cases) {
    let calls = 0;
    const client = new TransmissionClient(1000, async () => {
      calls++;
      return response();
    });
    await assert.rejects(client.verify('http://nas:9091', credential), (error: unknown) => {
      return error instanceof IntegrationValidationError && error.failureType === failureType;
    });
    assert.ok(calls <= 2);
  }
});

test('maps network and timeout errors without echoing upstream secrets', async () => {
  for (const [upstream, failure] of [
    [new Error('secret:with:colons'), 'network'],
    [new DOMException('secret:with:colons', 'TimeoutError'), 'timeout'],
  ] as const) {
    const client = new TransmissionClient(1000, async () => {
      throw upstream;
    });
    await assert.rejects(client.verify('http://nas:9091', credential), (error: unknown) => {
      assert.ok(error instanceof IntegrationValidationError);
      assert.equal(error.failureType, failure);
      assert.equal(String(error).includes(credential.password), false);
      return true;
    });
  }
});

test('adds base64 torrent content and accepts duplicate responses without requiring a label mutation', async () => {
  for (const modern of [false, true]) {
    for (const duplicate of [false, true]) {
      let count = 0;
      const client = new TransmissionClient(1000, async (_url, init) => {
        count++;
        if (count === 1)
          return new Response(null, {
            status: 409,
            headers: {
              'X-Transmission-Session-Id': 'session',
              ...(modern ? { 'X-Transmission-Rpc-Version': '6.0.0' } : {}),
            },
          });
        const body = JSON.parse(String(init?.body));
        assert.equal(body.method, modern ? 'torrent_add' : 'torrent-add');
        assert.deepEqual(modern ? body.params : body.arguments, {
          metainfo: 'AQID',
          labels: ['movie-hub-one'],
          paused: false,
        }
        );
        const key = modern
          ? duplicate
            ? 'torrent_duplicate'
            : 'torrent_added'
          : duplicate
            ? 'torrent-duplicate'
            : 'torrent-added';
        const args = { [key]: { [modern ? 'hash_string' : 'hashString']: 'ABC123', name: 'Movie', id: 1 } };
        return Response.json(
          modern ? { jsonrpc: '2.0', id: 1, result: args } : { result: 'success', tag: 1, arguments: args },
        );
      });
      assert.equal(
        await client.addTorrent('http://nas:9091', credential, new Uint8Array([1, 2, 3]), 'movie-hub-one'),
        'abc123',
      );
      assert.equal(count, 2);
    }
  }
});

test('queries hashes and converts legacy and modern torrent fields into progress snapshots', async () => {
  for (const modern of [false, true]) {
    let count = 0;
    const client = new TransmissionClient(1000, async (_url, init) => {
      count++;
      if (count === 1)
        return new Response(null, {
          status: 409,
          headers: {
            'X-Transmission-Session-Id': 'session',
            ...(modern ? { 'X-Transmission-Rpc-Version': '6.0.0' } : {}),
          },
        });
      const body = JSON.parse(String(init?.body));
      const params = modern ? body.params : body.arguments;
      assert.equal(body.method, modern ? 'torrent_get' : 'torrent-get');
      assert.deepEqual(params.ids, ['abc123']);
      assert.ok(params.fields.includes(modern ? 'percent_done' : 'percentDone'));
      const torrent = modern
        ? { hash_string: 'ABC123', percent_done: 0.4, downloaded_ever: 400, size_when_done: 1000, rate_download: 20 }
        : { hashString: 'ABC123', percentDone: 0.4, downloadedEver: 400, sizeWhenDone: 1000, rateDownload: 20 };
      const args = {
        torrents: [{ ...torrent, name: 'Movie', status: 4, error: 0, eta: -1, labels: ['movie-hub-one'] }],
      };
      return Response.json(
        modern ? { jsonrpc: '2.0', id: 1, result: args } : { result: 'success', tag: 1, arguments: args },
      );
    });
    assert.deepEqual(await client.listTorrents('http://nas:9091', credential, ['abc123']), [
      {
        hash: 'abc123',
        name: 'Movie',
        status: 4,
        error: 0,
        progress: 0.4,
        downloadedBytes: 400,
        totalBytes: 1000,
        downloadSpeed: 20,
        etaSeconds: 0,
        labels: ['movie-hub-one'],
      },
    ]
    );
  }
});

test('finds recovery labels and rejects incomplete add and torrent-list responses', async () => {
  const client = new TransmissionClient(1000, async () => {
    return Response.json({
      result: 'success',
      tag: 1,
      arguments: {
        torrents: [
          { hashString: 'ABC', name: 'Other', status: 4, error: 0, percentDone: 0.5, labels: ['other'] },
          { hashString: 'DEF', name: 'Movie', status: 0, error: 0, percentDone: 0.2, labels: ['wanted'] },
        ],
      },
    }
    );
  });
  assert.equal((await client.findByTag('http://nas', credential, 'wanted'))?.hash, 'def');
  assert.equal(await client.findByTag('http://nas', credential, 'absent'), null);
  const invalid = new TransmissionClient(1000, async () => {
    return Response.json({ result: 'success', tag: 1, arguments: { torrents: [{}] } });
  });
  await assert.rejects(
    invalid.addTorrent('http://nas', credential, new Uint8Array(), 'tag'),
    IntegrationValidationError,
  );
  await assert.rejects(invalid.listTorrents('http://nas', credential), IntegrationValidationError);
});
