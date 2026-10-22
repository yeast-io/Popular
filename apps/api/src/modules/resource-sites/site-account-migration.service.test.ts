import assert from 'node:assert/strict';
import test from 'node:test';
import { SiteAccountMigrationService } from './site-account-migration.service.js';
import { SecretCrypto } from '../integrations/secret-crypto.js';
import { integrationSecretContext } from '../integrations/integration.service.js';
import { HDAreaAdapter } from '../../infrastructure/hdarea/hdarea.adapter.js';
import type { SiteAccountMigrationEntry } from './site-account-migration.types.js';

const secrets = new SecretCrypto('migration-test-secret-at-least-32-characters');

test('backfills authenticated identities without saving credentials or changing site configuration', async () => {
  const entries: SiteAccountMigrationEntry[] = [
    { site: 'mteam', ownerId: 'A', encryptedCredential: secrets.encrypt('private-key', integrationSecretContext('A', 'mteam')) },
    { site: 'hdarea', ownerId: 'B', encryptedCredential: secrets.encrypt('session=private-cookie', 'movie-hub:resource-site:hdarea:owner:B') },
  ];
  const assigned: unknown[] = [];
  const service = new SiteAccountMigrationService({
    listPending: async () => entries,
    assign: async (entry, id) => {
      assigned.push([entry.site, id]);
      return true;
    },
  }, {
    verify: async (url, key) => {
      assert.equal(url, 'https://api.m-team.cc');
      assert.equal(key, 'private-key');
      return '101';
    },
  }, 'https://api.m-team.cc', new Map([['hdarea', new HDAreaAdapter('https://hdarea.club/')]]), {
    session: async (_baseUrl, cookie) => {
      assert.equal(cookie, 'session=private-cookie');
      return { get: async () => Buffer.from('<a href="usercp.php">Account</a><div id="info_block"><a href="userdetails.php?id=202">Me</a></div>') };
    },
  }, secrets, { logger: { error() {} }, verbose: false });
  assert.deepEqual(await service.migrate(), { migrated: 2, unresolved: 0 });
  assert.deepEqual(assigned, [['mteam', '101'], ['hdarea', '202']]);
});

test('keeps historical conflicts and failed verification unresolved, preserving safe diagnostic causes', async () => {
  const entries: SiteAccountMigrationEntry[] = ['A', 'B'].map((ownerId) => ({
    ownerId, site: 'mteam', encryptedCredential: secrets.encrypt(`private-key-${ownerId}`, integrationSecretContext(ownerId, 'mteam')),
  }));
  const logs: unknown[] = [];
  let assignments = 0;
  const service = new SiteAccountMigrationService({
    listPending: async () => entries,
    assign: async () => {
      assignments++;
      throw new Error('duplicate identity 123456789');
    },
  }, {
    verify: async (_url, key) => {
      if (key.endsWith('-B')) throw new Error(`expired credential ${key}`, { cause: new Error('upstream failure') });
      return '123456789';
    },
  }, 'https://api.m-team.cc', new Map(), { session: async () => { throw new Error('unused'); } }, secrets, {
    logger: { error: (...args: unknown[]) => { logs.push(args); } }, verbose: false,
  });
  assert.deepEqual(await service.migrate(), { migrated: 0, unresolved: 2 });
  assert.equal(assignments, 1);
  const json = JSON.stringify(logs);
  assert.equal(json.includes('private-key'), false);
  assert.equal(json.includes('123456789'), false);
  assert.match(json, /upstream failure/);
  assert.match(json, /site-account.migration.verify/);
  assert.match(json, /correlationId/);
});
