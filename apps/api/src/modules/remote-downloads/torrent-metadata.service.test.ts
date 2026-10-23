import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readTorrentMetadata } from './torrent-metadata.service.js';
import { TORRENT_METADATA_MAX_BYTES } from './torrent-metadata.policy.js';
import { AiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';

const info = 'd4:name4:test6:pieces20:aaaaaaaaaaaaaaaaaaaae';
const torrent = 'd4:info' + info + 'e';
const hash = createHash('sha1').update(info).digest('hex');

for (const status of [301, 302, 303, 307, 308]) {
  test(`follows ${status} to a relative HTTPS target and hashes the final torrent`, async () => {
    const requests: URL[] = [];
    const signals: AbortSignal[] = [];
    let cancelled = false;
    const result = await readTorrentMetadata('https://tracker.example/start?token=private', {
      fetch: async (input, init) => {
        requests.push(new URL(String(input)));
        signals.push(init!.signal!);
        assert.equal(init!.redirect, 'manual');
        assert.equal(init!.credentials, 'omit');
        assert.equal(init!.referrerPolicy, 'no-referrer');
        assert.equal(init!.headers, undefined);
        return requests.length === 1
          ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { location: '/file.torrent?token=private' } })
          : new Response(torrent);
      },
    });
    assert.equal(result, hash);
    assert.equal(requests.length, 2);
    assert.equal(requests[1]!.pathname, '/file.torrent');
    assert.equal(signals[0], signals[1]);
    assert.equal(cancelled, true);
  });
}

test('allows an HTTPS CDN redirect without copying credentials or request headers', async () => {
  const requests: string[] = [];
  assert.equal(await readTorrentMetadata('https://tracker.example/start?passkey=PRIVATE', {
    fetch: async (input, init) => {
      requests.push(String(input));
      assert.equal(init!.headers, undefined);
      return requests.length === 1
        ? new Response(null, { status: 302, headers: { location: 'https://cdn.example/file.torrent' } })
        : new Response(torrent);
    },
  }), hash);
  assert.deepEqual(requests, ['https://tracker.example/start?passkey=PRIVATE', 'https://cdn.example/file.torrent']);
});

for (const location of ['http://tracker.example/file', 'https://user:password@tracker.example/file',
  'https://tracker.example/file#fragment', 'file:///tmp/torrent']) {
  test(`blocks an invalid redirect target: ${location.split(':')[0]}`, async () => {
    let calls = 0;
    await assert.rejects(readTorrentMetadata('https://tracker.example/start', {
      fetch: async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location } });
      },
    }), { code: 'INVALID_TORRENT_URL' });
    assert.equal(calls, 1);
  });
}

test('bounds redirects, rejects loops and missing Location, and cancels redirect bodies', async () => {
  for (const mode of ['limit', 'loop', 'missing']) {
    let calls = 0;
    let cancelled = 0;
    await assert.rejects(readTorrentMetadata('https://tracker.example/start', {
      fetch: async () => {
        calls++;
        return new Response(new ReadableStream({ cancel() {
          cancelled++;
        } }), { status: 302,
          headers: mode === 'missing' ? {} : { location: mode === 'loop' ? '/start' : `/hop-${calls}` } });
      },
    }), { code: 'TORRENT_METADATA_UNAVAILABLE' });
    assert.equal(calls, mode === 'limit' ? 4 : 1);
    assert.equal(cancelled, calls);
  }
});

test('preserves HTTP failures, parsing failures and final-body size limits', async () => {
  await assert.rejects(readTorrentMetadata('https://tracker.example/start', {
    fetch: async () => new Response('Forbidden', { status: 403 }),
  }), { code: 'TORRENT_METADATA_UNAVAILABLE' });
  await assert.rejects(readTorrentMetadata('https://tracker.example/start', {
    fetch: async () => new Response('<html>Login</html>'),
  }), { code: 'INVALID_TORRENT_METADATA' });
  for (const declared of [false, true]) {
    let cancelled = false;
    await assert.rejects(readTorrentMetadata('https://tracker.example/start', {
      fetch: async () => new Response(new ReadableStream({
        start(controller) { if (!declared) controller.enqueue(new Uint8Array(TORRENT_METADATA_MAX_BYTES + 1)); },
        cancel() { cancelled = true; },
      }), { headers: declared ? { 'content-length': String(TORRENT_METADATA_MAX_BYTES + 1) } : {} }),
    }), { code: 'TORRENT_METADATA_TOO_LARGE' });
    assert.equal(cancelled, true);
  }
});

test('redirects share one timeout budget and redact original and destination URLs from diagnostics', async () => {
  const start = 'https://tracker.example/start?passkey=PRIVATE_START';
  const destination = 'https://cdn.example/file?passkey=PRIVATE_DESTINATION';
  const logged: string[] = [];
  const trace = new AiTrace({ info: (value: unknown) => logged.push(JSON.stringify(value)),
    error: (value: unknown) => logged.push(JSON.stringify(value)) }, { correlationId: 'metadata-test' }, '', 'metadata', true);
  let calls = 0;
  await assert.rejects(withAiTrace(trace, () => readTorrentMetadata(start, {
    fetch: async () => {
      if (++calls === 1) return new Response(null, { status: 302, headers: { location: destination } });
      throw new Error(`Failed ${start} ${destination}`);
    },
  })), { code: 'TORRENT_METADATA_UNAVAILABLE' });
  assert(!logged.join('').includes('PRIVATE_'));
  assert(logged.join('').includes('metadata-test'));

  let signal: AbortSignal | undefined;
  await assert.rejects(readTorrentMetadata(start, {
    timeoutMs: 10,
    fetch: async (_input, init) => {
      if (!signal) {
        signal = init!.signal!;
        return new Response(null, { status: 302, headers: { location: destination } });
      }
      assert.equal(init!.signal, signal);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      signal.throwIfAborted();
      return new Response(torrent);
    },
  }), { code: 'TORRENT_METADATA_UNAVAILABLE' });
  assert.equal(signal!.aborted, true);
});
