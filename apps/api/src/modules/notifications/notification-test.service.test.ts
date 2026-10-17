import assert from 'node:assert/strict';
import test from 'node:test';
import { NotificationTestService } from './notification-test.service.js';
import { NotificationService } from './notification.service.js';
import type { NotificationStore } from './notification.types.js';
import type { MovieDownloadRecord } from '../downloads/movie-download.types.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config/env.js';
const id = '507f1f77bcf86cd799439011';
function fixture() {
  const sent: string[] = [];
  const reads: string[] = [];
  const record: MovieDownloadRecord = { id, ownerId: 'alice', tmdbId: 7, provider: 'qbittorrent', sourceProvider: 'mteam', sourceReleaseId: 'r', lookupTag: 'tag', status: 'completed', progress: 100, name: 'release', totalBytes: 1024 };
  const auth = { requireOwnerId: async (token: string | undefined) => { if (!token) throw new AppError(401, 'UNAUTHORIZED', 'Login required'); return token; } };
  const store = { preferences: async () => ({ enabled: false, defaultChannel: 'whatsapp', additionalChannels: ['future'], epoch: 0 }) } as unknown as NotificationStore;
  const notifications = new NotificationService(auth, store, ['whatsapp', 'telegram', 'future', 'unlinked'].map(channel => ({ id: channel, name: channel, isConfigured: async () => channel !== 'unlinked', send: async (owner, payload) => {
    assert.equal(payload.poster?.toString(), 'poster'); assert.equal(payload.resourceName, 'release');
    if (channel === 'future') throw new Error('offline'); sent.push(`${owner}:${channel}`); return { messageId: 'accepted' };
  } })));
  let now = Date.now();
  const service = new NotificationTestService(auth, {
    listCompleted: async (owner, skip, limit) => { reads.push(owner); assert.equal(skip, 0); assert.equal(limit, 31); return owner === 'alice' ? [record] : []; },
    findCompleted: async (owner, requested) => owner === 'alice' && requested === id ? record : null,
  }, notifications, { readMovies: async () => [{ tmdbId: 7, title: 'Movie', genreIds: [], posterPath: '/p.jpg' }] }, 'zh-CN', 'http://localhost:5173',
  async row => ({ id: 'manual', title: 'Movie', resourceName: row.name!, provider: row.provider, totalBytes: row.totalBytes!, completedAt: new Date(), detailUrl: '/movies/7', poster: Buffer.from('poster') }), () => new Date(now));
  return { service, sent, reads, advance: () => { now += 30000; } };
}
const environment = {
  WEB_ORIGIN: 'http://localhost:5173', MONGODB_URI: 'mongodb://db.example/movie_hub', REDIS_URL: 'redis://redis.example:6379',
  MINIO_ENDPOINT: 'minio.example', MINIO_ACCESS_KEY: 'access', MINIO_SECRET_KEY: 'secret', MINIO_BUCKET: 'avatars',
  SESSION_TOKEN_PEPPER: 'test-session-pepper-at-least-32-characters', INTEGRATION_SECRET_KEY: 'test-integration-secret-at-least-32-characters',
  TMDB_READ_ACCESS_TOKEN: 'tmdb-token', LOG_LEVEL: 'silent', ACCESS_LOG_ENABLED: 'false',
};
test('only the four allowed server environments expose test routes; production has no list or send endpoint', async () => {
  for (const NODE_ENV of ['development', 'test', 'local', 'dev', 'production']) {
    const f = fixture();
    const config = loadConfig({ ...environment, NODE_ENV });
    const app = await buildApp({ config, healthDependencies: [], notificationTestService: f.service });
    try {
      const base = '/api/v1/me/notification-tests/downloads';
      const production = NODE_ENV === 'production';
      assert.equal((await app.inject({ method: 'GET', url: '/api/v1/config' })).json().notificationTestEnabled, !production);
      assert.equal((await app.inject({ method: 'GET', url: base })).statusCode, production ? 404 : 401);
      const result = await app.inject({ method: 'POST', url: `${base}/${id}/send`, payload: { channel: 'whatsapp' } });
      assert.equal(result.statusCode, production ? 404 : 401);
      assert.equal(f.sent.length, 0);
    } finally { await app.close(); }
  }
});
test('lists only owned saved completed downloads with localized movie metadata', async () => {
  const f = fixture();
  await assert.rejects(() => f.service.list(undefined, 1), { code: 'UNAUTHORIZED' });
  const listed = await f.service.list('alice', 1);
  assert.equal(listed.items[0]?.title, 'Movie');
  assert.deepEqual(listed.channels.map(channel => [channel.id, channel.configured]), [['whatsapp', true], ['telegram', true], ['future', true], ['unlinked', false]]);
  assert.deepEqual((await f.service.list('bob', 1)).items, []);
  assert.deepEqual(f.reads, ['alice', 'bob']);
  await assert.rejects(() => f.service.send('bob', id, 'whatsapp'), { code: 'NOT_FOUND' }); assert.equal(f.sent.length, 0);
});
test('manual tests send only the requested channel, independently of preferences, with separate cooldowns', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.send('alice', id, 'whatsapp'), { results: [{ channel: 'whatsapp', sent: true }] });
  assert.deepEqual(f.sent, ['alice:whatsapp']);
  await assert.rejects(() => f.service.send('alice', id, 'whatsapp'), { code: 'CONFLICT' });
  assert.deepEqual(await f.service.send('alice', id, 'telegram'), { results: [{ channel: 'telegram', sent: true }] });
  assert.deepEqual(await f.service.send('alice', id, 'future'), { results: [{ channel: 'future', sent: false }] });
  await assert.rejects(() => f.service.send('alice', id, 'unsupported'), { code: 'VALIDATION_ERROR' });
  await assert.rejects(() => f.service.send('alice', id, 'unlinked'), { code: 'CONFLICT' });
  assert.deepEqual(f.sent, ['alice:whatsapp', 'alice:telegram']);
  f.advance(); await f.service.send('alice', id, 'whatsapp');
  assert.deepEqual(f.sent, ['alice:whatsapp', 'alice:telegram', 'alice:whatsapp']);
});
test('invalid download identifiers and pages are rejected before querying MongoDB or sending', async () => {
  const f = fixture();
  const app = await buildApp({ config: loadConfig({ ...environment, NODE_ENV: 'test' }), healthDependencies: [], notificationTestService: f.service });
  try {
    const headers = { cookie: 'movie_hub_session=alice' };
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me/notification-tests/downloads?page=0', headers })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/me/notification-tests/downloads/invalid/send', headers })).statusCode, 400);
    assert.equal(f.reads.length, 0); assert.equal(f.sent.length, 0);
  } finally { await app.close(); }
});

test('HTTP sends only the explicitly selected registered channel and rejects missing or unknown selections', async () => {
  const f = fixture();
  const app = await buildApp({ config: loadConfig({ ...environment, NODE_ENV: 'test' }), healthDependencies: [], notificationTestService: f.service });
  const headers = { cookie: 'movie_hub_session=alice' };
  const url = `/api/v1/me/notification-tests/downloads/${id}/send`;
  try {
    assert.equal((await app.inject({ method: 'POST', url, headers })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: { channel: 'unknown' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: { channel: 'unlinked' } })).statusCode, 409);
    assert.equal(f.sent.length, 0);
    const result = await app.inject({ method: 'POST', url, headers, payload: { channel: 'telegram', ownerId: 'bob', recipient: 'attacker' } });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), { results: [{ channel: 'telegram', sent: true }] });
    assert.deepEqual(f.sent, ['alice:telegram']);
    const list = await app.inject({ url: '/api/v1/me/notification-tests/downloads', headers });
    assert.equal(list.json().channels.length, 4);
  } finally { await app.close(); }
});
