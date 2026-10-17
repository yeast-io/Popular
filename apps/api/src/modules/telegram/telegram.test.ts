import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramService, type TelegramStore, type TelegramRecord, type TelegramUpdate } from './telegram.service.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { TelegramClient } from '../../infrastructure/telegram/client.js';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config/env.js';

function fixture() {
  let now = new Date('2026-10-18T00:00:00Z');
  const rows = new Map<string, TelegramRecord & { hash?: string; testAt?: number }>();
  const sent: Array<{ chatId: string; text: string; photo?: Buffer; parseMode?: 'HTML' }> = [];
  const auth = { requireOwnerId: async (token: string | undefined) => {
    if (token !== 'alice' && token !== 'bob') throw new AppError(401, 'UNAUTHORIZED', 'Login required');
    return token;
  } };
  const store: TelegramStore = {
    find: async owner => rows.get(owner) ?? null,
    pending: async (owner, hash, expiresAt) => {
      if (rows.get(owner)?.chatId) return false;
      rows.set(owner, { hash, expiresAt }); return true;
    },
    consume: async (hash, chatId, account, date) => {
      if ([...rows.values()].some(row => row.chatId === chatId)) return false;
      for (const [owner, row] of rows) {
        if (row.hash === hash && row.expiresAt! > date && !row.chatId) { rows.set(owner, { chatId, account }); return true; }
      }
      return false;
    },
    remove: async owner => { rows.delete(owner); },
    reserveTest: async (owner, chat, date) => {
      const row = rows.get(owner);
      if (row?.chatId !== chat || row.testAt !== undefined && date.getTime() - row.testAt < 30_000) return false;
      row.testAt = date.getTime(); return true;
    },
  };
  const transport = { username: async () => 'PopularTestBot', send: async (chatId: string, text: string, parseMode?: 'HTML') => { sent.push({ chatId, text, ...(parseMode ? { parseMode } : {}) }); return String(sent.length); }, sendPhoto: async (chatId: string, photo: Buffer, text: string) => { sent.push({ chatId, photo, text, parseMode: 'HTML' }); return String(sent.length); }, updates: async () => [] };
  const service = new TelegramService(auth, store, transport, () => now);
  const update = (url: string, id = 101, type = 'private'): TelegramUpdate => ({ update_id: 1, message: {
    text: `/start ${new URL(url).searchParams.get('start')}`, from: { id, username: `person${id}` }, chat: { id, type },
  } });
  return { service, auth, store, rows, sent, transport, update, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

test('one-use expiring links accept only private self chats and cannot overwrite either account binding', async () => {
  const f = fixture();
  const original = await f.service.start('alice');
  const current = await f.service.start('alice');
  assert.notEqual(original.bindingUrl, current.bindingUrl);
  const secret = new URL(current.bindingUrl).searchParams.get('start')!;
  assert.equal(JSON.stringify([...f.rows.values()]).includes(secret), false);
  await f.service.accept(f.update(original.bindingUrl));
  await f.service.accept(f.update(current.bindingUrl, 101, 'group'));
  const forged = f.update(current.bindingUrl); forged.message!.from!.id = 999;
  await f.service.accept(forged);
  assert.equal((await f.service.get('alice')).status, 'pending');
  await f.service.accept(f.update(current.bindingUrl));
  assert.deepEqual(await f.service.get('alice'), { status: 'connected', account: '@person101' });
  assert.deepEqual(await f.service.get('bob'), { status: 'unbound' });
  await assert.rejects(() => f.service.start('alice'), { code: 'CONFLICT' });
  const bob = await f.service.start('bob');
  await f.service.accept(f.update(bob.bindingUrl));
  assert.equal((await f.service.get('bob')).status, 'pending');
  await f.service.remove('alice');
  await f.service.accept(f.update(current.bindingUrl)); // replay after unlink cannot restore it
  assert.equal((await f.service.get('alice')).status, 'unbound');
  f.advance(600_000);
  await f.service.accept(f.update(bob.bindingUrl, 202));
  assert.equal((await f.service.get('bob')).status, 'unbound');
  assert.equal(f.sent.length, 0);
});

test('test and download notifications always use authenticated owner binding; unlink stops subsequent sends', async () => {
  const f = fixture();
  for (const owner of ['alice', 'bob']) {
    const link = await f.service.start(owner);
    await f.service.accept(f.update(link.bindingUrl, owner === 'alice' ? 101 : 202));
  }
  await f.service.test('alice');
  await assert.rejects(() => f.service.test('alice'), { code: 'CONFLICT' });
  await f.service.sendNotification('bob', { id: 'task', title: 'Movie', resourceName: 'Release', provider: 'qbittorrent', totalBytes: 1, completedAt: new Date(), detailUrl: 'https://popular.example/movies/7' });
  assert.deepEqual(f.sent.map(row => row.chatId), ['101', '202']);
  f.advance(30_000); await f.service.test('alice');
  await f.service.remove('alice');
  await assert.rejects(() => f.service.test('alice'), { code: 'CONFLICT' });
  assert.equal(await f.service.isConfigured('alice'), false);
  assert.equal(await f.service.isConfigured('bob'), true);
});

test('unconfigured service still requires authentication and clearly reports unavailable', async () => {
  const f = fixture();
  const service = new TelegramService(f.auth, f.store);
  await assert.rejects(() => service.get(undefined), { code: 'UNAUTHORIZED' });
  assert.deepEqual(await service.get('alice'), { status: 'unavailable' });
  await assert.rejects(() => service.start('alice'), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(await service.isConfigured('alice'), false);
});

const config = loadConfig({ WEB_ORIGIN: 'http://localhost:5173', MONGODB_URI: 'mongodb://db.example/test', REDIS_URL: 'redis://redis.example',
  MINIO_ENDPOINT: 'minio.example', MINIO_ACCESS_KEY: 'access', MINIO_SECRET_KEY: 'secret', MINIO_BUCKET: 'avatars',
  SESSION_TOKEN_PEPPER: 'test-session-pepper-at-least-32-characters', INTEGRATION_SECRET_KEY: 'test-integration-secret-at-least-32-characters', TMDB_READ_ACCESS_TOKEN: 'tmdb', LOG_LEVEL: 'silent' });
test('HTTP endpoints reject anonymous access and ignore injected owner and recipient; links never appear in status', async () => {
  const f = fixture();
  const app = await buildApp({ config, healthDependencies: [], telegramService: f.service });
  const url = '/api/v1/me/integrations/telegram';
  try {
    for (const [method, suffix] of [['GET', ''], ['POST', '/bind'], ['POST', '/test'], ['DELETE', '']] as const) {
      assert.equal((await app.inject({ method, url: url + suffix })).statusCode, 401);
    }
    const headers = { cookie: 'movie_hub_session=alice' };
    const bound = await app.inject({ method: 'POST', url: url + '/bind', headers, payload: { ownerId: 'bob', chatId: '999' } });
    assert.equal(bound.statusCode, 200); assert.equal(bound.headers['cache-control'], 'no-store');
    await f.service.accept(f.update(bound.json().bindingUrl));
    const status = await app.inject({ url, headers });
    assert.deepEqual(status.json(), { status: 'connected', account: '@person101' });
    const sent = await app.inject({ method: 'POST', url: url + '/test', headers, payload: { ownerId: 'bob', chatId: '999', text: 'injected' } });
    assert.equal(sent.statusCode, 200); assert.equal(f.sent[0]!.chatId, '101'); assert.ok(!f.sent[0]!.text.includes('injected'));
    assert.equal((await app.inject({ method: 'DELETE', url, headers })).statusCode, 204);
    assert.equal(f.rows.size, 0);
  } finally { await app.close(); }
});

test('transport uses POST and strips token-bearing fetch errors and Telegram responses', async () => {
  const token = '123:private-token';
  for (const fetcher of [async () => { throw new Error(`request failed https://api.telegram.org/bot${token}`); }, async () => Response.json({ ok: false, description: token }, { status: 401 })]) {
    const client = new TelegramClient(token, fetcher as typeof fetch);
    await assert.rejects(() => client.username(), error => {
      assert.ok(error instanceof AppError); assert.ok(!String(error).includes(token)); assert.equal(error.cause, undefined); return true;
    });
  }
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new TelegramClient(token, (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json({ ok: true, result: url.endsWith('/getMe') ? { is_bot: true, username: 'PopularTestBot' } : url.endsWith('/getUpdates') ? [] : { message_id: 9 } });
  }) as typeof fetch);
  assert.equal(await client.username(), 'PopularTestBot'); await client.username();
  assert.equal(await client.send('101', '<b>test</b>', 'HTML'), '9'); await client.updates(8);
  assert.equal(calls.length, 3); assert.ok(calls.every(row => row.init.method === 'POST'));
  assert.equal(JSON.parse(calls[1]!.init.body as string).chat_id, '101');
  assert.equal(JSON.parse(calls[1]!.init.body as string).parse_mode, 'HTML');
  assert.equal(JSON.parse(calls[2]!.init.body as string).offset, 8);
});

test('download notification uses owner-scoped photo with escaped HTML, bounded caption and a detail link; missing poster uses HTML text', async () => {
  const f = fixture();
  const link = await f.service.start('alice');
  await f.service.accept(f.update(link.bindingUrl));
  const notification = { id: 'task', title: '<Movie> & "title"', resourceName: 'release & <b>not markup</b>', provider: 'qbittorrent', totalBytes: 1024 ** 3,
    completedAt: new Date('2026-10-18T00:00:00Z'), detailUrl: 'https://popular.example/movies/7?x=1&y=2', poster: Buffer.from('poster-bytes') };
  assert.deepEqual(await f.service.sendNotification('alice', notification), { messageId: '1' });
  const photo = f.sent[0]!;
  assert.equal(photo.chatId, '101'); assert.equal(photo.photo?.toString(), 'poster-bytes'); assert.equal(photo.parseMode, 'HTML');
  assert.ok(photo.text.includes('<b>&lt;Movie&gt; &amp; &quot;title&quot;</b>'));
  assert.ok(photo.text.includes('<code>release &amp; &lt;b&gt;not markup&lt;/b&gt;</code>'));
  assert.ok(photo.text.includes('href="https://popular.example/movies/7?x=1&amp;y=2"'));
  assert.ok(photo.text.includes('1.00 GiB'));
  await assert.rejects(() => f.service.sendNotification('bob', notification), { code: 'CONFLICT' });
  assert.equal(f.sent.length, 1);
  const { poster: _poster, ...withoutPoster } = notification;
  await f.service.sendNotification('alice', withoutPoster);
  assert.equal(f.sent[1]!.photo, undefined); assert.equal(f.sent[1]!.parseMode, 'HTML');
  await f.service.sendNotification('alice', { ...notification, title: '😀&'.repeat(2000), resourceName: '<😀'.repeat(2000), provider: 'x'.repeat(2000), detailUrl: 'javascript:alert(1)' });
  const caption = f.sent[2]!.text;
  const parsed = caption.replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, '_');
  assert.ok(parsed.length < 1024); assert.ok(!caption.includes('javascript:'));
  assert.ok(!caption.includes('\uFFFD')); assert.ok(caption.includes('…</b>')); assert.ok(caption.includes('…</code>'));
});

test('photo upload sends actual poster bytes as multipart with HTML caption, without a fixed content-type header', async () => {
  const calls: RequestInit[] = [];
  const client = new TelegramClient('123:secret', (async (url: string, init: RequestInit) => {
    assert.ok(url.endsWith('/sendPhoto')); calls.push(init);
    return Response.json({ ok: true, result: { message_id: 99 } });
  }) as typeof fetch);
  assert.equal(await client.sendPhoto('101', Buffer.from([1, 2, 3]), '<b>Movie</b>'), '99');
  const init = calls[0]!; assert.equal(init.method, 'POST'); assert.equal(init.headers, undefined);
  const form = init.body; assert.ok(form instanceof FormData);
  assert.equal(form.get('chat_id'), '101'); assert.equal(form.get('parse_mode'), 'HTML'); assert.equal(form.get('caption'), '<b>Movie</b>');
  const file = form.get('photo'); assert.ok(file instanceof Blob);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from([1, 2, 3]));
  const unavailable = new TelegramClient('123:secret', (async () => { throw new Error('https://api.telegram.org/bot123:secret/sendPhoto'); }) as typeof fetch);
  await assert.rejects(() => unavailable.sendPhoto('101', Buffer.from('poster'), 'text'), error => {
    assert.ok(error instanceof AppError); assert.ok(!String(error).includes('123:secret')); assert.equal(error.cause, undefined); return true;
  });
  const invalid = new TelegramClient('123:secret', (async () => Response.json({ ok: true, result: {} })) as typeof fetch);
  await assert.rejects(() => invalid.sendPhoto('101', Buffer.from('poster'), 'text'), { code: 'SERVICE_UNAVAILABLE' });
});
