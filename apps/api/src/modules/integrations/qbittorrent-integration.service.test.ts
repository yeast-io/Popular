import { maskIntegrationSecret } from '@movie-hub/contract';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthService } from '../auth/auth.service.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { SecretCrypto } from './secret-crypto.js';
import { QBittorrentIntegrationService, normalizeQBittorrentBaseUrl } from './qbittorrent-integration.service.js';
import type { QBittorrentClientPort, QBittorrentConfigRecord, QBittorrentConfigStore } from './qbittorrent.types.js';

test('accepts public qBittorrent addresses but rejects local hosts and unsafe URLs', () => {
  assert.equal(normalizeQBittorrentBaseUrl(' http://8.8.8.8:8080/ '), 'http://8.8.8.8:8080');
  assert.equal(normalizeQBittorrentBaseUrl('https://downloads.example.com/qbit/'), 'https://downloads.example.com/qbit');
  for (const value of ['ftp://nas/qbit', 'http://user:pass@nas:8080', 'http://nas:8080?target=x',
    'http://192.168.1.20:8080', 'http://localhost:8080', 'http://nas:8080', 'not a url']) {
    assert.throws(() => normalizeQBittorrentBaseUrl(value), AppError);
  }
});

test('validates and encrypts API-key credentials without returning the secret', async () => {
  const records: QBittorrentConfigRecord[] = [];
  const store: QBittorrentConfigStore = {
    async find() {
      return records.at(-1) ?? null;
    },
    async saveVerified(input) {
      records.push(input);
      return input;
    },
    async recordFailure() {},
    async delete() {
      records.length = 0;
    },
  };
  const calls: unknown[] = [];
  const client = {
    async verify(baseUrl, credential) {
      calls.push({ baseUrl, credential });
      return { version: '5.2.0' };
    },
  } as QBittorrentClientPort;
  const auth = { requireOwnerId: async () => '507f1f77bcf86cd799439011' } as unknown as AuthService;
  const secrets = new SecretCrypto('test-integration-secret-key-that-is-long-enough');
  const service = new QBittorrentIntegrationService(auth, store, client, secrets, () => {
    return new Date('2026-10-13T00:00:00Z');
  });

  const response = await service.save('session', {
    baseUrl: 'https://downloads.example.com:8080/',
    authMethod: 'api_key',
    apiKey: 'qbt_top_secret',
  }
  );

  assert.deepEqual(calls, [
    { baseUrl: 'https://downloads.example.com:8080', credential: { authMethod: 'api_key', apiKey: 'qbt_top_secret' } },
  ]
  );
  assert.equal(response.version, '5.2.0');
  assert.equal('apiKey' in response, false);
  assert.notEqual(records[0]?.encryptedCredential, 'qbt_top_secret');
  assert.equal(response.apiKeyMasked, maskIntegrationSecret('qbt_top_secret'));
  assert.equal((await service.get('session')).apiKeyMasked, response.apiKeyMasked);
  await service.save('session', { baseUrl: 'https://downloads.example.com:8080', authMethod: 'api_key', apiKey: response.apiKeyMasked });
  assert.deepEqual(calls.at(-1), {
    baseUrl: 'https://downloads.example.com:8080',
    credential: { authMethod: 'api_key', apiKey: 'qbt_top_secret' },
  }
  );
  const verifiedCalls = calls.length;
  await assert.rejects(service.save('session', {
    baseUrl: 'http://192.168.1.20:8080', authMethod: 'api_key', apiKey: response.apiKeyMasked,
  }), { code: 'QBITTORRENT_INVALID_URL' });
  assert.equal(calls.length, verifiedCalls);
  records.push({ ...records.at(-1)!, baseUrl: 'http://nas:8080' });
  assert.equal((await service.get('session')).status, 'configured_invalid');
  await assert.rejects(service.retest('session'), { code: 'QBITTORRENT_INVALID_URL' });
  assert.equal(calls.length, verifiedCalls);
});

test('creates independent named qBittorrent instances and removes only the selected one', async () => {
  const records = new Map<string, QBittorrentConfigRecord>();
  const store: QBittorrentConfigStore = {
    async find(owner, id) {
      return [...records.values()].find((record) => record.ownerId === owner && record.downloaderInstanceId === id) ?? null;
    },
    async list(owner) {
      return [...records.values()].filter((record) => record.ownerId === owner);
    },
    async saveVerified(input) {
      records.set(input.downloaderInstanceId!, input);
      return input;
    },
    async recordFailure() {},
    async delete(_owner, id) {
      records.delete(id!);
    },
  };
  const auth = { requireOwnerId: async () => '507f1f77bcf86cd799439011' } as unknown as AuthService;
  const client = { verify: async () => ({ version: '5.2' }) } as unknown as QBittorrentClientPort;
  const service = new QBittorrentIntegrationService(auth, store, client, new SecretCrypto('test-integration-secret-key-that-is-long-enough'));
  const home = await service.create('session', { name: 'Home', baseUrl: 'https://home.example.com', authMethod: 'api_key', apiKey: 'home-secret' });
  const seedbox = await service.create('session', { name: 'Seedbox', baseUrl: 'https://seedbox.example.com', authMethod: 'api_key', apiKey: 'seedbox-secret' });
  assert.notEqual(home.downloaderInstanceId, seedbox.downloaderInstanceId);
  assert.equal((await service.list('session')).length, 2);
  await assert.rejects(service.get('session'), { code: 'DOWNLOAD_PROVIDER_REQUIRED' });
  assert.equal((await service.get('session', seedbox.downloaderInstanceId)).name, 'Seedbox');
  await service.delete('session', home.downloaderInstanceId);
  assert.deepEqual((await service.list('session')).map((item) => item.name), ['Seedbox']);
});
