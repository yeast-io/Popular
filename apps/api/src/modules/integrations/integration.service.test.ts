import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthService } from '../auth/auth.service.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import {
  IntegrationService,
  IntegrationValidationError,
  normalizeMTeamBaseUrl,
} from './integration.service.js';
import type { IntegrationConfigRecord, IntegrationConfigStore, MTeamVerifier } from './integration.types.js';
import { SecretCrypto } from './secret-crypto.js';

class MemoryConfigStore implements IntegrationConfigStore {
  readonly records = new Map<string, IntegrationConfigRecord>();
  get record() { return this.records.values().next().value ?? null; }
  private key(ownerId: string, provider: 'mteam') { return `${ownerId}:${provider}`; }
  async find(ownerId: string, provider: 'mteam') { return this.records.get(this.key(ownerId, provider)) ?? null; }
  async saveVerified(input: IntegrationConfigRecord & { verifiedAt: Date; lastValidationAt: Date }) {
    const record = { ...input };
    delete record.lastFailureType;
    this.records.set(this.key(input.ownerId, input.provider), record);
    return record;
  }
  async recordFailure(ownerId: string, provider: 'mteam', attemptedAt: Date, failureType: IntegrationConfigRecord['lastFailureType']) {
    const record = this.records.get(this.key(ownerId, provider));
    if (record && failureType) this.records.set(this.key(ownerId, provider), { ...record, lastValidationAt: attemptedAt, lastFailureType: failureType });
  }
  async delete(ownerId: string, provider: 'mteam') { this.records.delete(this.key(ownerId, provider)); }
}

class StubVerifier implements MTeamVerifier {
  error: Error | undefined;
  calls: Array<{ baseUrl: string; apiKey: string }> = [];
  async verify(baseUrl: string, apiKey: string) {
    this.calls.push({ baseUrl, apiKey });
    if (this.error) throw this.error;
  }
}

const auth = { requireOwnerId: async () => '507f1f77bcf86cd799439011' } as unknown as AuthService;
const allowedHosts = new Set(['api.m-team.cc', 'api.m-team.io']);
const crypto = new SecretCrypto('test-integration-secret-key-that-is-long-enough');
const now = new Date('2026-10-12T05:00:00.000Z');

function fixture() {
  const store = new MemoryConfigStore();
  const verifier = new StubVerifier();
  const service = new IntegrationService(auth, store, verifier, crypto, allowedHosts, () => now);
  return { store, verifier, service };
}

test('normalizes only allowed HTTPS M-Team base URLs', () => {
  assert.equal(normalizeMTeamBaseUrl(' https://API.M-TEAM.CC/// ', allowedHosts), 'https://api.m-team.cc');
  assert.equal(normalizeMTeamBaseUrl('https://api.m-team.io/api/', allowedHosts), 'https://api.m-team.io/api');
  for (const url of [
    'http://api.m-team.cc',
    'https://user:pass@api.m-team.cc',
    'https://api.m-team.cc?next=x',
    'https://api.m-team.cc#x',
    'https://api.m-team.cc:8443',
    'https://127.0.0.1',
    'https://evil.example',
    'https://api.m-team.cc/unexpected',
  ]) assert.throws(() => normalizeMTeamBaseUrl(url, allowedHosts), AppError);
});

test('validates before saving and never returns the API key', async () => {
  const { store, verifier, service } = fixture();
  const response = await service.saveMTeam('session', { baseUrl: 'https://api.m-team.cc/', apiKey: '  top-secret  ' });
  assert.deepEqual(verifier.calls, [{ baseUrl: 'https://api.m-team.cc', apiKey: 'top-secret' }]);
  assert.equal(response.status, 'configured_valid');
  assert.equal(response.lastValidationAt, now.toISOString());
  assert.equal('apiKey' in response, false);
  assert.notEqual(store.record?.encryptedApiKey, 'top-secret');
  assert.equal(
    crypto.decrypt(store.record?.encryptedApiKey ?? '', 'movie-hub:integration:mteam:owner:507f1f77bcf86cd799439011'),
    'top-secret',
  );
});

test('failed replacement preserves the existing URL and secret while recording failure state', async () => {
  const { store, verifier, service } = fixture();
  await service.saveMTeam('session', { baseUrl: 'https://api.m-team.cc', apiKey: 'working-key' });
  const encryptedBefore = store.record?.encryptedApiKey;
  verifier.error = new IntegrationValidationError('authentication', 'invalid key');

  await assert.rejects(
    service.saveMTeam('session', { baseUrl: 'https://api.m-team.io', apiKey: 'bad-key' }),
    (error: unknown) => error instanceof AppError && error.code === 'MTEAM_AUTH_FAILED',
  );
  assert.equal(store.record?.baseUrl, 'https://api.m-team.cc');
  assert.equal(store.record?.encryptedApiKey, encryptedBefore);
  assert.equal((await service.getMTeam('session')).status, 'configured_invalid');
  assert.equal((await service.getMTeam('session')).lastFailureType, 'authentication');
});

test('can replace only the URL by retaining the encrypted server-side API key', async () => {
  const { verifier, service } = fixture();
  await service.saveMTeam('session', { baseUrl: 'https://api.m-team.cc', apiKey: 'working-key' });
  await service.saveMTeam('session', { baseUrl: 'https://api.m-team.io' });
  assert.deepEqual(verifier.calls[1], { baseUrl: 'https://api.m-team.io', apiKey: 'working-key' });
  assert.equal((await service.getMTeam('session')).baseUrl, 'https://api.m-team.io');
});

test('requires an API key for the first configuration', async () => {
  const { service } = fixture();
  await assert.rejects(
    service.saveMTeam('session', { baseUrl: 'https://api.m-team.cc' }),
    (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_ERROR',
  );
});

test('failed first validation does not create a configuration', async () => {
  const { store, verifier, service } = fixture();
  verifier.error = new IntegrationValidationError('network', 'offline');
  await assert.rejects(service.saveMTeam('session', { baseUrl: 'https://api.m-team.cc', apiKey: 'bad-key' }));
  assert.equal(store.record, null);
  assert.equal((await service.getMTeam('session')).status, 'unconfigured');
});

test('keeps configurations and decrypted credentials isolated by authenticated owner', async () => {
  const store = new MemoryConfigStore();
  const verifier = new StubVerifier();
  const ownerAuth = {
    requireOwnerId: async (token: string | undefined) => {
      if (token === 'alice-session') return '507f1f77bcf86cd799439011';
      if (token === 'bob-session') return '507f191e810c19729de860ea';
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    },
  } as unknown as AuthService;
  const service = new IntegrationService(ownerAuth, store, verifier, crypto, allowedHosts, () => now);

  await service.saveMTeam('alice-session', { baseUrl: 'https://api.m-team.cc', apiKey: 'alice-secret' });
  await service.saveMTeam('bob-session', { baseUrl: 'https://api.m-team.io', apiKey: 'bob-secret' });
  assert.equal((await service.getMTeam('alice-session')).baseUrl, 'https://api.m-team.cc');
  assert.equal((await service.getMTeam('bob-session')).baseUrl, 'https://api.m-team.io');

  await service.retestMTeam('alice-session');
  await service.retestMTeam('bob-session');
  assert.deepEqual(verifier.calls.slice(-2), [
    { baseUrl: 'https://api.m-team.cc', apiKey: 'alice-secret' },
    { baseUrl: 'https://api.m-team.io', apiKey: 'bob-secret' },
  ]);

  await service.deleteMTeam('alice-session');
  assert.equal((await service.getMTeam('alice-session')).status, 'unconfigured');
  assert.equal((await service.getMTeam('bob-session')).status, 'configured_valid');
});
