import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import type { RemoteAuthorizationChange } from '@movie-hub/contract';
import { AiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { SecretCrypto } from '../integrations/secret-crypto.js';
import { RemoteClientService } from './remote-client.service.js';
import type { RemoteClientAccount, RemoteDeviceRecord, RemoteAuthorizationStore } from './remote-client.types.js';

function fixture() {
  const accounts = new Map<string, RemoteClientAccount>();
  const devices = new Map<string, RemoteDeviceRecord>();
  const notifications: RemoteAuthorizationChange[] = [];
  let offline = false;
  const store: RemoteAuthorizationStore = {
    async account(owner) {
      return structuredClone(accounts.get(owner) ?? { key: null, deviceLimit: 1 });
    },
    async changeKey(owner, kind, input, secrets, event) {
      const account = accounts.get(owner) ?? { key: null, deviceLimit: 1 };
      const previous = account.key;
      if (
        (previous?.authVersion ?? 0) !== input.expectedAuthVersion
        || (kind === 'generate' ? Boolean(previous?.active) : !previous?.active)
        || previous?.operations.some((item) => item.operationId === input.operationId)
      )
        return false;
      account.key = {
        ownerId: owner,
        active: kind !== 'revoke',
        authVersion: input.expectedAuthVersion + 1,
        ...(secrets ?? (previous?.keyDigest ? { keyDigest: previous.keyDigest } : {})),
        operations: [
          ...(previous?.operations ?? []),
          { operationId: input.operationId, kind, expectedAuthVersion: input.expectedAuthVersion },
        ],
        pending: event,
      };
      accounts.set(owner, account);
      return true;
    },
    async devices(owner, version) {
      return structuredClone(
        [...devices.values()].filter((row) => {
          return row.ownerId === owner && row.authVersion === version && row.status === 'bound';
        })
      );
    },
    async device(owner, id) {
      const row = devices.get(id);
      return row?.ownerId === owner ? structuredClone(row) : null;
    },
    async unbind(owner, id, input, event) {
      const row = devices.get(id);
      if (
        !row
        || row.ownerId !== owner
        || row.authVersion !== input.expectedAuthVersion
        || row.deviceVersion !== input.expectedDeviceVersion
        || row.status !== 'bound'
        || row.operations.some((item) => {
          return item.operationId === input.operationId;
        })
      )
        return false;
      row.status = 'unbound';
      row.deviceVersion++;
      row.operations.push(input);
      row.pending = event;
      return true;
    },
    async pending(owner) {
      return structuredClone(
        [
          ...[...accounts.values()].flatMap((account) => (account.key?.pending ? [account.key.pending] : [])),
          ...[...devices.values()].flatMap((device) => (device.pending ? [device.pending] : [])),
        ].filter((event) => !owner || event.ownerId === owner)
      );
    },
    async acknowledge(event) {
      if (event.scope === 'key') {
        const key = accounts.get(event.ownerId)?.key;
        if (key?.pending?.eventId === event.eventId && key.pending.authVersion === event.authVersion)
          delete key.pending;
      } else {
        const device = devices.get(event.deviceId);
        if (
          device?.pending?.eventId === event.eventId
          && device.pending.scope === 'device'
          && device.pending.deviceVersion === event.deviceVersion
        )
          delete device.pending;
      }
    },
  };
  const gateway = {
    async notify(event: RemoteAuthorizationChange) {
      notifications.push(structuredClone(event));
      if (offline) throw new Error('simulated Gateway unavailable');
    },
  };
  const secrets = new SecretCrypto('test-encryption-material-independent-of-rcck');
  const service = new RemoteClientService(store, gateway, secrets);
  // A simulated Gateway, not an implementation of the external service.
  const bind = (owner: string, deviceId: string) => {
    const account = accounts.get(owner)!;
    assert.ok(account.key?.active);
    assert.ok(!devices.has(deviceId), 'rebinding must allocate a new deviceId');
    const count = [...devices.values()].filter(
      (row) => row.ownerId === owner && row.authVersion === account.key!.authVersion && row.status === 'bound'
    ).length;
    if (count >= account.deviceLimit) throw new Error('device quota exceeded');
    const row: RemoteDeviceRecord = {
      ownerId: owner,
      deviceId,
      authVersion: account.key!.authVersion,
      deviceVersion: 1,
      status: 'bound',
      boundAt: new Date('2026-10-21T00:00:00Z'),
      operations: [],
    };
    devices.set(deviceId, row);
    return row;
  };
  const allowed = (id: string, deviceVersion = 1) => {
    const device = devices.get(id);
    const key = device && accounts.get(device.ownerId)?.key;
    return Boolean(
      key?.active
      && key.authVersion === device?.authVersion
      && device?.status === 'bound'
      && device.deviceVersion === deviceVersion
    );
  };
  return {
    accounts,
    devices,
    notifications,
    store,
    gateway,
    secrets,
    service,
    bind,
    allowed,
    offline(value: boolean) {
      offline = value;
    },
  };
}
const mutation = (expectedAuthVersion: number) => ({ operationId: randomUUID(), expectedAuthVersion });
const unbindInput = (authVersion = 1, deviceVersion = 1) => {
  return { ...mutation(authVersion), expectedDeviceVersion: deviceVersion };
};

test('one RCCK per user, encrypted storage plus digest; repeated owner reads and idempotent requests return the same key', async () => {
  const f = fixture();
  const input = mutation(0);
  const result = await f.service.change('alice', 'generate', input, 'trace-1', 'en-US');
  assert.match(result.apiKey!, /^premote_[A-Za-z0-9_-]{43}$/);
  const stored = f.accounts.get('alice')!.key!;
  assert.equal(stored.keyDigest, createHash('sha256').update(result.apiKey!).digest('hex'));
  assert.ok(stored.encryptedKey);
  assert.ok(!JSON.stringify([...f.accounts]).includes(result.apiKey!));
  assert.equal((await f.service.readKey('alice', 'en-US')).apiKey, result.apiKey);
  assert.equal((await f.service.readKey('alice', 'en-US')).apiKey, result.apiKey);
  assert.equal((await f.service.change('alice', 'generate', input, 'retry', 'en-US')).apiKey, result.apiKey);
  assert.equal(f.accounts.get('alice')!.key!.authVersion, 1);
  assert.equal((await f.service.get('alice')).canReadKey, true);
  assert.ok(!JSON.stringify(await f.service.get('alice')).includes(result.apiKey!));
  assert.equal((await f.service.get('bob')).hasKey, false);
  await assert.rejects(f.service.readKey('bob', 'en-US'), { statusCode: 404 });
  await assert.rejects(f.service.change('alice', 'generate', mutation(1), 'trace', 'en-US'), { statusCode: 409 });
});

test('concurrent generation and rotation keep one identity and reject reused operation IDs with different content', async () => {
  const f = fixture();
  const input = mutation(0);
  const generated = await Promise.all([
    f.service.change('alice', 'generate', input, 'a', 'en-US'),
    f.service.change('alice', 'generate', input, 'b', 'en-US'),
  ]
  );
  assert.equal(generated[0]!.apiKey, generated[1]!.apiKey);
  const rotation = mutation(1);
  const rotated = await Promise.all([
    f.service.change('alice', 'regenerate', rotation, 'a', 'en-US'),
    f.service.change('alice', 'regenerate', rotation, 'b', 'en-US'),
  ]
  );
  assert.equal(rotated[0]!.apiKey, rotated[1]!.apiKey);
  assert.notEqual(rotated[0]!.apiKey, generated[0]!.apiKey);
  assert.equal(f.accounts.get('alice')!.key!.authVersion, 2);
  await assert.rejects(f.service.change('alice', 'revoke', { ...input, expectedAuthVersion: 2 }, 'a', 'zh-CN'), {
    statusCode: 409,
    message: '授权已变更或操作冲突，请刷新后重试。',
  }
  );
  assert.equal((await f.service.change('alice', 'generate', input, 'retry-old', 'en-US')).apiKey, null);
});

test('three-device simulation: unbinding one device leaves the RCCK, other devices and their versions valid', async () => {
  const f = fixture();
  const original = await f.service.change('alice', 'generate', mutation(0), 'a', 'en-US');
  f.accounts.get('alice')!.deviceLimit = 3;
  f.bind('alice', 'device-a');
  f.bind('alice', 'device-b');
  f.bind('alice', 'device-c');
  const input = unbindInput();
  const result = await f.service.unbind('alice', 'device-b', input, 'unbind-trace', 'zh-CN');
  assert.equal(result.hasKey, true);
  assert.equal(result.authVersion, 1);
  assert.deepEqual(
    result.devices.map((device) => device.id),
    ['device-a', 'device-c']
  );
  assert.equal((await f.service.readKey('alice', 'en-US')).apiKey, original.apiKey);
  assert.equal(f.allowed('device-a'), true);
  assert.equal(f.allowed('device-b'), false);
  assert.equal(f.allowed('device-c'), true);
  assert.equal(f.notifications.at(-1)!.scope, 'device');
  assert.equal(f.devices.get('device-b')!.deviceVersion, 2);
  f.bind('alice', 'explicitly-rebound-device');
  await f.service.unbind('alice', 'device-b', input, 'retry', 'en-US');
  assert.equal(f.allowed('explicitly-rebound-device'), true);
  assert.equal((await f.service.get('alice')).devices.length, 3);
  await assert.rejects(f.service.unbind('bob', 'device-a', unbindInput(), 'a', 'en-US'), { statusCode: 404 });
});

test('default quota is one; simulated explicit binding can reuse released capacity without resetting the key', async () => {
  const f = fixture();
  await f.service.change('alice', 'generate', mutation(0), 'a', 'en-US');
  assert.equal((await f.service.get('alice')).deviceLimit, 1);
  f.bind('alice', 'device-a');
  assert.throws(() => f.bind('alice', 'device-b'), /quota exceeded/);
  await f.service.unbind('alice', 'device-a', unbindInput(), 'a', 'en-US');
  assert.equal((await f.service.get('alice')).devices.length, 0);
  f.bind('alice', 'device-b');
  assert.equal(f.allowed('device-a'), false);
  assert.equal(f.allowed('device-b'), true);
});

test('revoking a key immediately invalidates all devices even offline and removes readable secret; next generation gets a newer version', async () => {
  const f = fixture();
  const original = await f.service.change('alice', 'generate', mutation(0), 'a', 'en-US');
  f.accounts.get('alice')!.deviceLimit = 3;
  for (const id of ['a', 'b', 'c']) f.bind('alice', id);
  f.offline(true);
  const logs: unknown[] = [];
  const trace = new AiTrace(
    {
      error: (fields: unknown) => {
        logs.push(fields);
      },
    },
    { correlationId: 'revoke' },
    '',
    'test',
    false
  );
  const input = mutation(1);
  const result = await withAiTrace(trace, () => f.service.change('alice', 'revoke', input, 'revoke', 'en-US'));
  assert.equal(result.configuration.hasKey, false);
  assert.equal(result.configuration.canReadKey, false);
  assert.equal(result.configuration.gatewayNotificationPending, true);
  assert.deepEqual(result.configuration.devices, []);
  for (const id of ['a', 'b', 'c']) assert.equal(f.allowed(id), false);
  assert.equal(f.accounts.get('alice')!.key!.encryptedKey, undefined);
  assert.ok(logs.length > 0);
  assert.ok(!JSON.stringify(logs).includes(original.apiKey!));
  await assert.rejects(f.service.readKey('alice', 'zh-CN'), { statusCode: 404 });
  f.offline(false);
  await f.service.retryNotifications();
  assert.equal((await f.service.get('alice')).gatewayNotificationPending, false);
  const next = await f.service.change('alice', 'generate', mutation(2), 'next', 'en-US');
  assert.equal(next.configuration.authVersion, 3);
  assert.notEqual(next.apiKey, original.apiKey);
  await f.service.change('alice', 'revoke', input, 'late-retry', 'en-US');
  assert.equal((await f.service.get('alice')).hasKey, true);
});

test('device unbind offline is authoritative, retains readable key, and retries the same scoped event', async () => {
  const f = fixture();
  const original = await f.service.change('alice', 'generate', mutation(0), 'a', 'en-US');
  f.bind('alice', 'device-a');
  f.offline(true);
  await f.service.unbind('alice', 'device-a', unbindInput(), 'original-correlation', 'en-US');
  assert.equal(f.allowed('device-a'), false);
  assert.equal((await f.service.readKey('alice', 'en-US')).apiKey, original.apiKey);
  const event = f.notifications.at(-1)!;
  assert.equal(event.scope, 'device');
  f.offline(false);
  await f.service.retryNotifications();
  assert.deepEqual(f.notifications.at(-1), event);
  assert.equal((await f.service.get('alice')).gatewayNotificationPending, false);
});

test('legacy digest-only key requires explicit regeneration; cipher cannot be decrypted under another owner or version', async () => {
  const f = fixture();
  await f.service.change('alice', 'generate', mutation(0), 'a', 'en-US');
  const ciphertext = f.accounts.get('alice')!.key!.encryptedKey!;
  assert.throws(() => f.secrets.decrypt(ciphertext, 'remote-client:rcck:bob:1'));
  assert.throws(() => f.secrets.decrypt(ciphertext, 'remote-client:rcck:alice:2'));
  delete f.accounts.get('alice')!.key!.encryptedKey;
  assert.equal((await f.service.get('alice')).hasKey, true);
  assert.equal((await f.service.get('alice')).canReadKey, false);
  await assert.rejects(f.service.readKey('alice', 'zh-CN'), {
    statusCode: 409,
    message: '此密钥由旧版本生成，无法显示。请重新生成后查看和复制。',
  }
  );
  await f.service.change('alice', 'regenerate', mutation(1), 'a', 'en-US');
  assert.equal((await f.service.get('alice')).canReadKey, true);
  f.accounts.get('alice')!.key!.encryptedKey = 'corrupt';
  await assert.rejects(f.service.readKey('alice', 'en-US'), (error) => {
    assert.equal((error as { statusCode: number }).statusCode, 503);
    assert.ok((error as Error).cause instanceof Error);
    return true;
  });
});

test('old notification acknowledgements cannot erase a newer key event or another device event', async () => {
  const f = fixture();
  await f.service.change('alice', 'generate', mutation(0), 'a', 'en-US');
  f.offline(true);
  await f.service.change('alice', 'regenerate', mutation(1), 'b', 'en-US');
  const old = f.accounts.get('alice')!.key!.pending!;
  await f.service.change('alice', 'regenerate', mutation(2), 'c', 'en-US');
  await f.store.acknowledge(old);
  assert.equal(f.accounts.get('alice')!.key!.pending!.authVersion, 3);
  assert.equal((await f.store.pending('bob')).length, 0);
});

test('HTTP owner isolation, repeatable no-store key reads, separate revoke and per-device unbind contracts', async () => {
  const { buildApp } = await import('../../app.js');
  const { loadConfig } = await import('../../config/env.js');
  const { AppError } = await import('../../infrastructure/http/app-error.js');
  const config = loadConfig({
    NODE_ENV: 'test',
    WEB_ORIGIN: 'http://localhost:5173',
    MONGODB_URI: 'mongodb://db.example/movie_hub',
    REDIS_URL: 'redis://redis.example:6379',
    MINIO_ENDPOINT: 'minio.example',
    MINIO_ACCESS_KEY: 'access',
    MINIO_SECRET_KEY: 'secret',
    MINIO_BUCKET: 'avatars',
    SESSION_TOKEN_PEPPER: 'test-session-pepper-at-least-32-characters',
    INTEGRATION_SECRET_KEY: 'test-integration-secret-key-at-least-32-characters',
    TMDB_READ_ACCESS_TOKEN: 'test-token',
    ACCESS_LOG_ENABLED: 'false',
    LOG_LEVEL: 'silent',
  }
  );
  const f = fixture();
  const auth = {
    async requireOwnerId(token?: string) {
      if (!token) throw new AppError(401, 'UNAUTHORIZED', '');
      return token;
    },
  };
  const app = await buildApp({
    config,
    healthDependencies: [],
    remoteClientService: f.service,
    authService: auth as import('../auth/auth.service.js').AuthService,
  }
  );
  const base = '/api/v1/me/remote-client';
  const headers = { 'cookie': `${config.SESSION_COOKIE_NAME}=alice`, 'accept-language': 'en-US' };
  try {
    assert.equal((await app.inject({ method: 'GET', url: `${base}/key` })).statusCode, 401);
    for (const action of ['generate', 'regenerate', 'revoke'])
      assert.equal(
        (await app.inject({ method: 'POST', url: `${base}/${action}`, payload: mutation(0) })).statusCode,
        401
      );
    const created = await app.inject({ method: 'POST', url: `${base}/generate`, headers, payload: mutation(0) });
    assert.equal(created.statusCode, 200);
    const key = created.json().apiKey;
    assert.equal(created.headers['cache-control'], 'no-store');
    for (let retry = 0; retry < 2; retry++) {
      const read = await app.inject({ method: 'GET', url: `${base}/key`, headers });
      assert.equal(read.statusCode, 200);
      assert.equal(read.json().apiKey, key);
      assert.equal(read.headers['cache-control'], 'no-store');
      assert.equal(read.headers.pragma, 'no-cache');
    }
    const publicState = await app.inject({ method: 'GET', url: base, headers });
    assert.ok(!publicState.body.includes(key));
    assert.ok(!publicState.body.includes('encryptedKey'));
    const bob = { cookie: `${config.SESSION_COOKIE_NAME}=bob` };
    assert.equal((await app.inject({ method: 'GET', url: `${base}/key`, headers: bob })).statusCode, 404);
    f.bind('alice', 'device-a');
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/devices/device-a/unbind`,
          headers: bob,
          payload: unbindInput(),
        }
        )
      ).statusCode,
      404
    );
    const unbound = await app.inject({
      method: 'POST',
      url: `${base}/devices/device-a/unbind`,
      headers,
      payload: unbindInput(),
    }
    );
    assert.equal(unbound.statusCode, 200);
    assert.equal(unbound.json().hasKey, true);
    assert.equal(unbound.json().authVersion, 1);
    assert.deepEqual(unbound.json().devices, []);
    assert.equal((await app.inject({ method: 'GET', url: `${base}/key`, headers })).json().apiKey, key);
    const revoked = await app.inject({ method: 'POST', url: `${base}/revoke`, headers, payload: mutation(1) });
    assert.equal(revoked.statusCode, 200);
    assert.equal(revoked.json().configuration.hasKey, false);
    assert.equal((await app.inject({ method: 'GET', url: `${base}/key`, headers })).statusCode, 404);
    assert.equal(
      (await app.inject({ method: 'POST', url: `${base}/unbind`, headers, payload: mutation(2) })).statusCode,
      404
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/devices/device-a/unbind`,
          headers,
          payload: { ...unbindInput(), expectedDeviceVersion: 0 },
        }
        )
      ).statusCode,
      400
    );
  } finally {
    await app.close();
  }
});
