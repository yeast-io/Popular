import assert from 'node:assert/strict';
import test from 'node:test';
import { QBittorrentClient } from './client.js';

test('uses bearer API-key authentication and parses torrent progress', async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetchStub: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({ url: String(input), authorization: headers.get('authorization') });
    if (String(input).endsWith('/app/version')) return new Response('5.2.0');
    return Response.json([
      {
        hash: 'ABC123',
        name: 'Movie',
        state: 'downloading',
        progress: 0.42,
        downloaded: 420,
        total_size: 1000,
        dlspeed: 12,
        eta: 48,
        tags: 'movie-hub, movie-hub-id',
      },
    ]
    );
  };
  const client = new QBittorrentClient(1_000, fetchStub);

  assert.deepEqual(await client.verify('http://qbittorrent:8080', { authMethod: 'api_key', apiKey: 'qbt_secret' }), {
    version: '5.2.0',
  }
  );
  const torrents = await client.listTorrents(
    'http://qbittorrent:8080',
    { authMethod: 'api_key', apiKey: 'qbt_secret' },
    ['ABC123'],
  );

  assert.equal(requests[0]?.authorization, 'Bearer qbt_secret');
  assert.match(requests[1]?.url ?? '', /hashes=ABC123$/);
  assert.deepEqual(torrents[0], {
    hash: 'ABC123',
    name: 'Movie',
    state: 'downloading',
    progress: 0.42,
    downloadedBytes: 420,
    totalBytes: 1000,
    downloadSpeed: 12,
    etaSeconds: 48,
    tags: ['movie-hub', 'movie-hub-id'],
  }
  );
});

test('logs in with username and password and forwards only the SID cookie', async () => {
  const requests: Array<{ url: string; cookie: string | null; body: string }> = [];
  const fetchStub: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      cookie: new Headers(init?.headers).get('cookie'),
      body: init?.body instanceof URLSearchParams ? init.body.toString() : '',
    }
    );
    if (String(input).endsWith('/auth/login')) {
      return new Response('Ok.', { headers: { 'set-cookie': 'SID=session-value; HttpOnly; Path=/' } });
    }
    return new Response('4.6.7');
  };
  const client = new QBittorrentClient(1_000, fetchStub);

  await client.verify('http://nas:8080', { authMethod: 'username_password', username: 'daniel', password: 'secret' });

  assert.equal(requests[0]?.body, 'username=daniel&password=secret');
  assert.equal(requests[1]?.cookie, 'SID=session-value');
});

test('accepts legacy and qBittorrent 5.2 torrent-add success responses', async () => {
  const responses = [
    new Response('Ok.'),
    Response.json({ added_torrent_ids: ['ABC123'], failure_count: 0, success_count: 1 }),
  ];
  const requestHeaders: Headers[] = [];
  const fetchStub: typeof fetch = async (_input, init) => {
    requestHeaders.push(new Headers(init?.headers));
    return responses.shift() ?? new Response('Fails.');
  };
  const client = new QBittorrentClient(1_000, fetchStub);
  const credential = { authMethod: 'api_key' as const, apiKey: 'qbt_secret' };

  await client.addTorrent('http://qbittorrent:8080', credential, new Uint8Array([1, 2, 3]), 'movie-hub-one');
  await client.addTorrent('http://qbittorrent:8080', credential, new Uint8Array([4, 5, 6]), 'movie-hub-two');

  assert.equal(requestHeaders[0]?.get('referer'), 'http://qbittorrent:8080/');
});

test('rejects an unsuccessful structured torrent-add response', async () => {
  const fetchStub: typeof fetch = async () => {
    return Response.json({
      added_torrent_ids: [],
      failure_count: 1,
      success_count: 0,
    });
  };
  const client = new QBittorrentClient(1_000, fetchStub);

  await assert.rejects(
    client.addTorrent(
      'http://qbittorrent:8080',
      { authMethod: 'api_key', apiKey: 'qbt_secret' },
      new Uint8Array([1, 2, 3]),
      'movie-hub-failed',
    ),
    /qBittorrent rejected the torrent/,
  );
});
