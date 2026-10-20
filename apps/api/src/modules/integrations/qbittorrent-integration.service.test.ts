import { maskIntegrationSecret } from '@movie-hub/contract';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthService } from '../auth/auth.service.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { SecretCrypto } from './secret-crypto.js';
import { QBittorrentIntegrationService, normalizeQBittorrentBaseUrl } from './qbittorrent-integration.service.js';
import type { QBittorrentClientPort, QBittorrentConfigRecord, QBittorrentConfigStore } from './qbittorrent.types.js';

test('accepts LAN qBittorrent addresses but rejects embedded credentials and query strings', () => {
  assert.equal(normalizeQBittorrentBaseUrl(' http://192.168.1.20:8080/ '), 'http://192.168.1.20:8080');
  assert.equal(normalizeQBittorrentBaseUrl('https://nas.example/qbit/'), 'https://nas.example/qbit');
  for (const value of ['ftp://nas/qbit', 'http://user:pass@nas:8080', 'http://nas:8080?target=x', 'not a url']) {
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
    baseUrl: 'http://nas:8080/',
    authMethod: 'api_key',
    apiKey: 'qbt_top_secret',
  }
  );

  assert.deepEqual(calls, [
    { baseUrl: 'http://nas:8080', credential: { authMethod: 'api_key', apiKey: 'qbt_top_secret' } },
  ]
  );
  assert.equal(response.version, '5.2.0');
  assert.equal('apiKey' in response, false);
  assert.notEqual(records[0]?.encryptedCredential, 'qbt_top_secret');
  assert.equal(response.apiKeyMasked, maskIntegrationSecret('qbt_top_secret'));
  assert.equal((await service.get('session')).apiKeyMasked, response.apiKeyMasked);
  await service.save('session', { baseUrl: 'http://nas:8080', authMethod: 'api_key', apiKey: response.apiKeyMasked });
  assert.deepEqual(
    calls.at(-1),
    { baseUrl: 'http://nas:8080', credential: { authMethod: 'api_key', apiKey: 'qbt_top_secret' } }
  );

});
