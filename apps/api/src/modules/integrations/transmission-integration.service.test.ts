import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthService } from '../auth/auth.service.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { SecretCrypto } from './secret-crypto.js';
import { TransmissionIntegrationService, normalizeTransmissionBaseUrl, decryptCredential } from './transmission-integration.service.js';
import type { TransmissionConfigRecord, TransmissionConfigStore, TransmissionCredential } from './transmission.types.js';
import { IntegrationValidationError } from './integration.service.js';

function fixture() {
  const records = new Map<string, TransmissionConfigRecord>();
  const calls: { baseUrl: string; credential: TransmissionCredential }[] = [];
  let failure: unknown;
  const store: TransmissionConfigStore = {
    async find(ownerId) {
      return records.get(ownerId) ?? null;
    },
    async saveVerified(input) {
      const record = { ...input };
      delete record.lastFailureType;
      records.set(input.ownerId, record);
      return record;
    },
    async recordFailure(ownerId, attemptedAt, failureType) {
      const record = records.get(ownerId);
      if (record) records.set(ownerId, { ...record, lastValidationAt: attemptedAt, lastFailureType: failureType });
    },
    async delete(ownerId) {
      records.delete(ownerId);
    },
  };
  const auth = {
    requireOwnerId: async (token?: string) => {
      if (!token) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
      return token;
    },
  } as unknown as AuthService;
  const secrets = new SecretCrypto('test-integration-secret-key-that-is-long-enough');
  const service = new TransmissionIntegrationService(
    auth,
    store,
    {
      async verify(baseUrl, credential) {
        calls.push({ baseUrl, credential });
        if (failure) throw failure;
        return { version: '4.0.6' };
      },
    },
    secrets,
  );
  return {
    records,
    calls,
    secrets,
    service,
    failWith(error: unknown) {
      failure = error;
    },
  };
}

const input = { baseUrl: 'http://nas:9091/', username: 'daniel', password: 'transmission-secret' };

test('normalizes host addresses and rejects paths, embedded credentials and non-HTTP URLs', () => {
  assert.equal(normalizeTransmissionBaseUrl(' http://192.168.1.10:9091/ '), 'http://192.168.1.10:9091');
  assert.equal(normalizeTransmissionBaseUrl('https://NAS.example:443'), 'https://nas.example');
  assert.equal(normalizeTransmissionBaseUrl('http://[::1]:9091'), 'http://[::1]:9091');
  for (const value of [
    'ftp://nas',
    'http://u:p@nas',
    'http://nas?x=1',
    'http://nas#x',
    'http://nas/transmission/rpc',
    'http://nas/transmission/web/',
    'invalid',
  ]) {
    assert.throws(() => normalizeTransmissionBaseUrl(value), AppError);
  }
});

test('encrypts credentials per owner, never returns passwords and isolates configuration deletion', async () => {
  const { service, records, secrets } = fixture();
  await assert.rejects(service.get(undefined), { statusCode: 401 });
  const saved = await service.save('owner-one', input);
  assert.equal(saved.status, 'configured_valid');
  assert.equal(JSON.stringify(saved).includes(input.password), false);
  const record = records.get('owner-one')!;
  assert.equal(record.encryptedCredential.includes(input.password), false);
  assert.deepEqual(decryptCredential(record, secrets), { username: input.username, password: input.password });
  assert.throws(() => decryptCredential({ ...record, ownerId: 'owner-two' }, secrets), AppError);
  assert.equal((await service.get('owner-two')).status, 'unconfigured');
  await service.save('owner-two', input);
  await service.delete('owner-one');
  assert.equal((await service.get('owner-one')).status, 'unconfigured');
  assert.equal((await service.get('owner-two')).status, 'configured_valid');
});

test('retains a password only for the same address and username', async () => {
  const { service, calls } = fixture();
  await service.save('owner', input);
  await service.save('owner', { baseUrl: input.baseUrl, username: input.username });
  assert.equal(calls.at(-1)?.credential.password, input.password);
  for (const update of [
    { baseUrl: 'http://other:9091', username: input.username },
    { baseUrl: input.baseUrl, username: 'other' },
    { baseUrl: input.baseUrl, username: 'invalid:username', password: 'password' },
  ])
    await assert.rejects(service.save('owner', update), { code: 'VALIDATION_ERROR' });
  assert.equal(calls.length, 2);
});

test('failed candidate saves preserve current config; retest failures mark it invalid and can recover', async () => {
  const { service, records, failWith } = fixture();
  await service.save('owner', input);
  const original = records.get('owner')!;
  failWith(new IntegrationValidationError('authentication', 'private upstream message'));
  await assert.rejects(service.save('owner', { ...input, baseUrl: 'http://other:9091' }), {
    code: 'TRANSMISSION_AUTH_FAILED',
  }
  );
  assert.deepEqual(records.get('owner'), original);
  await assert.rejects(service.retest('owner'), { code: 'TRANSMISSION_AUTH_FAILED' });
  assert.equal((await service.get('owner')).status, 'configured_invalid');
  failWith(undefined);
  assert.equal((await service.retest('owner')).status, 'configured_valid');
  await assert.rejects(service.retest('absent'), { statusCode: 404 });
});

test('routes enforce sessions, validate payloads and serialize only public configuration fields', async () => {
  const { buildApp } = await import('../../app.js');
  const { loadConfig } = await import('../../config/env.js');
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
  }
  );
  const { service, failWith } = fixture();
  const app = await buildApp({ config, healthDependencies: [], transmissionIntegrationService: service });
  try {
    const url = '/api/v1/me/integrations/transmission';
    for (const method of ['GET', 'PUT', 'POST', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: method === 'POST' ? `${url}/test` : url,
        ...(method === 'PUT' ? { payload: input } : {}),
      }
      );
      assert.equal(response.statusCode, 401);
    }
    const headers = { cookie: `${config.SESSION_COOKIE_NAME}=owner` };
    const invalid = await app.inject({ method: 'PUT', url, headers, payload: { baseUrl: input.baseUrl } });
    assert.equal(invalid.statusCode, 400);
    const saved = await app.inject({ method: 'PUT', url, headers, payload: input });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().provider, 'transmission');
    assert.equal(saved.json().baseUrl, 'http://nas:9091');
    for (const key of ['password', 'encryptedCredential', 'ownerId']) assert.equal(key in saved.json(), false);
    const other = await app.inject({ method: 'GET', url, headers: { cookie: `${config.SESSION_COOKIE_NAME}=other` } });
    assert.equal(other.json().status, 'unconfigured');
    const retest = await app.inject({ method: 'POST', url: `${url}/test`, headers });
    assert.equal(retest.statusCode, 200);
    failWith(new Error(`network failure with ${input.password}`));
    const failed = await app.inject({ method: 'PUT', url, headers, payload: input });
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json().error.code, 'TRANSMISSION_UNREACHABLE');
    assert.equal(failed.body.includes(input.password), false);
    const removed = await app.inject({ method: 'DELETE', url, headers });
    assert.equal(removed.statusCode, 204);
    const empty = await app.inject({ method: 'GET', url, headers });
    assert.equal(empty.json().status, 'unconfigured');
  } finally {
    await app.close();
  }
});
