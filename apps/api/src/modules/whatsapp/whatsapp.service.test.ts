import assert from 'node:assert/strict';
import test from 'node:test';
import { WhatsAppService } from './whatsapp.service.js';
import type { WhatsAppConnectionOptions, WhatsAppStore } from './whatsapp.types.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config/env.js';

function fixture() {
  const records = new Map<string, string>();
  const leases = new Map<string, string>();
  const connections: Array<{ options: WhatsAppConnectionOptions; sent: number; stopped: boolean; logouts: boolean[] }> = [];
  const store: WhatsAppStore = {
    exists: async owner => records.has(owner),
    acquire: async (owner, lease) => { if (leases.has(owner)) return false; leases.set(owner, lease); return true; },
    renew: async (owner, lease) => leases.get(owner) === lease,
    release: async (owner, lease) => { if (leases.get(owner) === lease) leases.delete(owner); },
    load: async (owner, lease) => { assert.equal(leases.get(owner), lease); return records.get(owner) ?? null; },
    save: async (owner, lease, state) => { assert.equal(leases.get(owner), lease); records.set(owner, state); },
    clear: async (owner, lease) => { assert.equal(leases.get(owner), lease); records.delete(owner); },
  };
  const auth = { requireOwnerId: async (token: string | undefined) => {
    if (token !== 'alice' && token !== 'bob') throw new AppError(401, 'UNAUTHORIZED', 'Login required');
    return token;
  } };
  const connect = async (options: WhatsAppConnectionOptions) => {
    const entry = { options, sent: 0, stopped: false, logouts: [] as boolean[] }; connections.push(entry);
    await options.save(await options.load() ?? `private-state-${connections.length}`);
    return { sendSelf: async () => { entry.sent++; return `message-${connections.indexOf(entry)}`; }, sendNotification: async () => { entry.sent++; return `download-${connections.indexOf(entry)}`; }, stop: async (logout: boolean) => { entry.stopped = true; entry.logouts.push(logout); } };
  };
  const service = new WhatsAppService(auth, store, connect);
  return { service, store, auth, connect, connections, records, leases };
}

test('owner-scoped QR, status, auth state, self-test and unlink never cross users', async () => {
  const f = fixture();
  try {
    for (const action of [() => f.service.get(undefined), () => f.service.start(undefined), () => f.service.test(undefined), () => f.service.remove(undefined)]) await assert.rejects(action, { code: 'UNAUTHORIZED' });
    assert.equal(f.connections.length, 0);
    await f.service.start('alice');
    const alice = f.connections[0]!;
    alice.options.update({ status: 'qr', qrDataUrl: 'data:image/png;base64,alice', qrExpiresAt: new Date(Date.now() + 60_000).toISOString() });
    assert.equal((await f.service.get('alice')).qrDataUrl, 'data:image/png;base64,alice');
    assert.deepEqual(await f.service.get('bob'), { status: 'unbound' });
    await f.service.start('bob');
    const bob = f.connections[1]!;
    alice.options.update({ status: 'connected', account: '••••1111' });
    bob.options.update({ status: 'connected', account: '••••2222' });
    assert.deepEqual(await f.service.test('alice'), { messageId: 'message-0' });
    assert.equal(alice.sent, 1); assert.equal(bob.sent, 0);
    await assert.rejects(() => f.service.test('alice'), { code: 'CONFLICT' });
    await f.service.remove('alice');
    assert.equal(alice.stopped, true); assert.equal(bob.stopped, false);
    assert.equal(f.records.has('alice'), false); assert.equal(f.records.has('bob'), true);
    alice.options.update({ status: 'connected', account: 'stale' });
    assert.deepEqual(await f.service.get('alice'), { status: 'unbound' });
    assert.equal((await f.service.get('bob')).account, '••••2222');
  } finally { await f.service.close(); }
});

test('concurrent bind is idempotent; cross-instance lease contention cannot open a second socket', async () => {
  const f = fixture();
  const other = new WhatsAppService(f.auth, f.store, f.connect);
  try {
    await Promise.all([f.service.start('alice'), f.service.start('alice'), f.service.start('alice')]);
    assert.equal(f.connections.length, 1);
    await assert.rejects(() => other.start('alice'), { code: 'CONFLICT' });
    await assert.rejects(() => other.remove('alice'), { code: 'CONFLICT' });
    assert.equal(f.connections.length, 1);
    await f.service.close();
    assert.equal(f.leases.size, 0);
    assert.deepEqual(await other.get('alice'), { status: 'disconnected' });
    await other.start('alice');
    assert.equal(f.connections.length, 2);
  } finally { await f.service.close(); await other.close(); }
});

test('expired QR is hidden; disconnected socket cannot send; lost lease stops connection', async () => {
  const f = fixture();
  try {
    await f.service.start('alice');
    const connection = f.connections[0]!;
    connection.options.update({ status: 'qr', qrDataUrl: 'private-qr', qrExpiresAt: new Date(0).toISOString() });
    assert.deepEqual(await f.service.get('alice'), { status: 'connecting' });
    await assert.rejects(() => f.service.test('alice'), { code: 'CONFLICT' });
    connection.options.update({ status: 'connected', account: '••••1111' });
    f.leases.set('alice', 'another-process');
    await assert.rejects(() => f.service.test('alice'), { code: 'CONFLICT' });
    assert.equal(connection.stopped, true); assert.equal(connection.sent, 0);
  } finally { await f.service.close(); }
});

const config = loadConfig({
  WEB_ORIGIN: 'http://localhost:5173', MONGODB_URI: 'mongodb://db.example/movie_hub', REDIS_URL: 'redis://redis.example:6379',
  MINIO_ENDPOINT: 'minio.example', MINIO_ACCESS_KEY: 'access', MINIO_SECRET_KEY: 'secret', MINIO_BUCKET: 'avatars',
  SESSION_TOKEN_PEPPER: 'test-session-pepper-at-least-32-characters', INTEGRATION_SECRET_KEY: 'test-integration-secret-at-least-32-characters',
  TMDB_READ_ACCESS_TOKEN: 'tmdb-token', LOG_LEVEL: 'silent',
});
test('HTTP endpoints require authentication, ignore recipient/owner injection, and do not cache QR responses', async () => {
  const f = fixture();
  const app = await buildApp({ config, healthDependencies: [], whatsappService: f.service });
  const url = '/api/v1/me/integrations/whatsapp';
  try {
    for (const [method, suffix] of [['GET', ''], ['POST', '/bind'], ['POST', '/test'], ['DELETE', '']] as const) {
      const result = await app.inject({ method, url: url + suffix });
      assert.equal(result.statusCode, 401);
    }
    const headers = { cookie: 'movie_hub_session=alice' };
    const bound = await app.inject({ method: 'POST', url: url + '/bind', headers, payload: { ownerId: 'bob', recipient: 'attacker' } });
    assert.equal(bound.statusCode, 200); assert.equal(bound.headers['cache-control'], 'no-store');
    assert.equal(f.records.has('alice'), true); assert.equal(f.records.has('bob'), false);
    f.connections[0]!.options.update({ status: 'connected', account: '••••1111' });
    const sent = await app.inject({ method: 'POST', url: url + '/test', headers, payload: { ownerId: 'bob', recipient: 'attacker', text: 'arbitrary message' } });
    assert.equal(sent.statusCode, 200); assert.equal(f.connections[0]!.sent, 1);
    const bob = await app.inject({ method: 'GET', url, headers: { cookie: 'movie_hub_session=bob' } });
    assert.deepEqual(bob.json(), { status: 'unbound' });
    assert.ok(!sent.body.includes('private-state'));
    const removed = await app.inject({ method: 'DELETE', url, headers });
    assert.equal(removed.statusCode, 204);
  } finally { await app.close(); await f.service.close(); }
});


test('unlink with an expired lease cannot log out a session owned by another process', async () => {
  const f = fixture();
  try {
    await f.service.start('alice');
    f.leases.set('alice', 'new-owner-lease');
    await assert.rejects(() => f.service.remove('alice'), { code: 'CONFLICT' });
    assert.deepEqual(f.connections[0]!.logouts, [false]);
    assert.equal(f.records.has('alice'), true);
    assert.equal(f.leases.get('alice'), 'new-owner-lease');
  } finally { await f.service.close(); }
});

test('failed startup releases its lease so a user can retry', async () => {
  const f = fixture();
  const broken = new WhatsAppService(f.auth, f.store, async () => { throw new Error('private transport failure'); });
  try {
    await assert.rejects(() => broken.start('alice'), { code: 'SERVICE_UNAVAILABLE' });
    assert.equal(f.leases.size, 0);
    await f.service.start('alice');
    assert.equal(f.connections.length, 1);
  } finally { await broken.close(); await f.service.close(); }
});

test('terminal reason survives socket cleanup and remains isolated to the owner', async () => {
  const f = fixture();
  try {
    await f.service.start('alice');
    f.connections[0]!.options.update({ status: 'disconnected', failureReason: 'forbidden', disconnectCode: 403 });
    assert.deepEqual(await f.service.get('alice'), { status: 'disconnected', failureReason: 'forbidden', disconnectCode: 403 });
    assert.equal(f.connections[0]!.stopped, true);
    assert.deepEqual(await f.service.get('bob'), { status: 'unbound' });
    await f.service.remove('alice');
    assert.deepEqual(await f.service.get('alice'), { status: 'unbound' });
  } finally { await f.service.close(); }
});

test('pairing is active and cannot start a competing binding', async () => {
  const f = fixture();
  try {
    await f.service.start('alice');
    f.connections[0]!.options.update({ status: 'pairing' });
    assert.deepEqual(await f.service.start('alice'), { status: 'pairing' });
    assert.equal(f.connections.length, 1);
    await assert.rejects(() => f.service.test('alice'), { code: 'CONFLICT' });
  } finally { await f.service.close(); }
});


test('background notifications restore only the requested linked owner after restart and never start binding for unlinked owners', async () => {
  const f = fixture();
  f.records.set('alice', 'saved-alice-state');
  const restored = new WhatsAppService(f.auth, f.store, async options => {
    assert.equal(await options.load(), 'saved-alice-state');
    const connection = await f.connect(options);
    setImmediate(() => options.update({ status: 'connected' }));
    return connection;
  });
  const notification = { id: 'task-a', title: 'Movie', resourceName: 'Release', provider: 'qbittorrent', totalBytes: 100, completedAt: new Date(), detailUrl: 'http://localhost:5173/movies/7' };
  try {
    await assert.rejects(() => restored.sendNotification('bob', notification), /not linked/);
    assert.equal(f.connections.length, 0);
    assert.deepEqual(await restored.sendNotification('alice', notification), { messageId: 'download-0' });
    assert.equal(f.connections.length, 1); assert.equal(f.connections[0]?.sent, 1);
    f.leases.set('alice', 'another-process');
    await assert.rejects(() => restored.sendNotification('alice', notification), /lease lost/);
    assert.equal(f.connections[0]?.sent, 1);
  } finally { await restored.close(); await f.service.close(); }
});
