import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTmdbPoster } from './poster.js';

test('poster loader permits only TMDB image paths and returns bounded image bytes', async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push(url);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    return new Response(Buffer.from('poster'), { headers: { 'content-type': 'image/jpeg' } });
  });
  for (const path of ['https://example.com/p.jpg', '//example.com/p.jpg', '/../p.jpg', '/p.jpg?token=x']) {
    assert.equal(await loadTmdbPoster(path), undefined);
  }
  assert.equal(requests.length, 0);
  assert.equal((await loadTmdbPoster('/poster.jpg'))?.toString(), 'poster');
  assert.deepEqual(requests, ['https://image.tmdb.org/t/p/w500/poster.jpg']);
});

test('poster loader rejects unsuccessful, non-image and oversized responses', async (t) => {
  let response = new Response('unavailable', { status: 503 });
  t.mock.method(globalThis, 'fetch', async () => response);
  assert.equal(await loadTmdbPoster('/poster.jpg'), undefined);
  response = new Response('not an image', { headers: { 'content-type': 'text/html' } });
  assert.equal(await loadTmdbPoster('/poster.jpg'), undefined);
  response = new Response(Buffer.alloc(5 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/jpeg' } });
  assert.equal(await loadTmdbPoster('/poster.jpg'), undefined);
});
