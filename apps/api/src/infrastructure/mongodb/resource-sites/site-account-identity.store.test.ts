import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createConnection, Types } from 'mongoose';
import { createIntegrationConfigModel } from '../integrations/integration-config.schema.js';
import { MongoIntegrationConfigStore } from '../integrations/integration-config.store.js';
import { createResourceSiteCredentialModel } from './resource-site-credential.schema.js';
import { MongoResourceSiteCredentialStore } from './resource-site-credential.store.js';
import { IntegrationService } from '../../../modules/integrations/integration.service.js';
import { ResourceSiteService } from '../../../modules/resource-sites/resource-site.service.js';
import { SecretCrypto } from '../../../modules/integrations/secret-crypto.js';
import { AppError } from '../../http/app-error.js';
import type { AuthService } from '../../../modules/auth/auth.service.js';
import type { ResourceSiteAdapter } from '../../../modules/resource-sites/resource-site.types.js';

const inUse = (error: unknown) => error instanceof AppError && error.statusCode === 409 && error.code === 'RESOURCE_SITE_ACCOUNT_IN_USE';
const pending = (error: unknown) => error instanceof AppError && error.statusCode === 503 && error.code === 'RESOURCE_SITE_IDENTITY_PENDING';

test('REAL Mongo: site identity uniqueness, concurrent binding, credential replacement and deletion release', {
  skip: !process.env.SITE_ACCOUNT_TEST_MONGODB_URI,
  timeout: 30_000,
}, async (t) => {
  const dbName = 'popular_site_identity_test_' + randomUUID().replaceAll('-', '');
  const connection = await createConnection(process.env.SITE_ACCOUNT_TEST_MONGODB_URI!, {
    dbName, serverSelectionTimeoutMS: 5000,
  }).asPromise();
  t.after(async () => {
    assert.match(connection.name, /^popular_site_identity_test_[a-f0-9]{32}$/);
    await connection.dropDatabase();
    await connection.close();
  });
  const integrations = createIntegrationConfigModel(connection);
  const credentials = createResourceSiteCredentialModel(connection);
  await Promise.all([integrations.init(), credentials.init()]);
  const mtStore = new MongoIntegrationConfigStore(integrations);
  const hdStore = new MongoResourceSiteCredentialStore(credentials);
  const ownerA = new Types.ObjectId().toString();
  const ownerB = new Types.ObjectId().toString();
  const secret = new SecretCrypto('test-integration-key-at-least-32-characters');
  const auth = { requireOwnerId: async (token: string) => token } as unknown as AuthService;
  const service = new IntegrationService(auth, mtStore, {
    verify: async (_baseUrl, key) => key.startsWith('account-2') ? '202' : '101',
  }, secret, new Set(['api.m-team.cc']));
  const mtInput = (apiKey: string) => ({ baseUrl: 'https://api.m-team.cc', apiKey });
  const attempts = await Promise.allSettled([
    service.saveMTeam(ownerA, mtInput('account-1-key-A')),
    service.saveMTeam(ownerB, mtInput('account-1-key-B')),
  ]);
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((r) => r.status === 'rejected' && inUse(r.reason)).length, 1);
  const winner = attempts[0]!.status === 'fulfilled' ? ownerA : ownerB;
  const loser = winner === ownerA ? ownerB : ownerA;
  assert.equal(await integrations.countDocuments(), 1);
  assert.equal((await mtStore.find(winner, 'mteam'))?.externalUserId, '101');
  assert.equal('externalUserId' in await service.getMTeam(winner), false);
  await service.saveMTeam(winner, mtInput('account-1-rotated-key'));
  await service.retestMTeam(winner);
  await service.saveMTeam(loser, mtInput('account-2-key'));
  const before = await mtStore.find(loser, 'mteam');
  await assert.rejects(service.saveMTeam(loser, mtInput('account-1-other-key')), inUse);
  assert.equal((await mtStore.find(loser, 'mteam'))?.encryptedApiKey, before?.encryptedApiKey);
  await service.deleteMTeam(winner);
  assert.equal(await mtStore.find(winner, 'mteam'), null);
  await service.saveMTeam(loser, mtInput('account-1-key-after-delete'));

  const adapter: ResourceSiteAdapter = {
    id: 'hdarea', name: 'HDArea', baseUrl: 'https://hdarea.club/',
    verify: async (session) => Buffer.from(await session.get('index.php')).toString(),
    search: async () => ({ releases: [] }),
    detail: async () => { throw new Error('Not used'); },
  };
  const hd = new ResourceSiteService(new Map([['hdarea', adapter]]), hdStore, secret, {
    session: async (_url, cookie) => ({ get: async () => Buffer.from(cookie.startsWith('account-2') ? '202' : '101') }),
  }, { logger: { error() {} }, verbose: false });
  const hdAttempts = await Promise.allSettled([
    hd.configure(ownerA, 'hdarea', 'account-1-cookie-A'),
    hd.configure(ownerB, 'hdarea', 'account-1-cookie-B'),
  ]);
  assert.equal(hdAttempts.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(hdAttempts.filter((r) => r.status === 'rejected' && inUse(r.reason)).length, 1);
  const hdWinner = hdAttempts[0]!.status === 'fulfilled' ? ownerA : ownerB;
  const hdLoser = hdWinner === ownerA ? ownerB : ownerA;
  assert.equal((await hdStore.find(hdWinner, 'hdarea'))?.externalUserId, '101');
  assert.equal('externalUserId' in await hd.configuration(hdWinner, 'hdarea'), false);
  // A numeric ID can independently exist at both sites.
  assert.equal((await mtStore.find(loser, 'mteam'))?.externalUserId, '101');
  await hd.configure(hdWinner, 'hdarea', 'account-1-rotated-cookie');
  await hd.configure(hdWinner, 'hdarea');
  await hd.configure(hdLoser, 'hdarea', 'account-2-cookie');
  const hdBefore = await hdStore.find(hdLoser, 'hdarea');
  await assert.rejects(hd.configure(hdLoser, 'hdarea', 'account-1-another-cookie'), inUse);
  assert.equal((await hdStore.find(hdLoser, 'hdarea'))?.encryptedCookie, hdBefore?.encryptedCookie);
  await hd.delete(hdWinner, 'hdarea');
  assert.equal(await hdStore.find(hdWinner, 'hdarea'), null);
  await hd.configure(hdLoser, 'hdarea', 'account-1-cookie-after-delete');

  // Unresolved legacy identities cannot be bypassed by creating a new binding.
  const legacyOwner = new Types.ObjectId();
  await integrations.collection.insertOne({ ownerId: legacyOwner, provider: 'mteam', baseUrl: 'https://api.m-team.cc', encryptedApiKey: 'legacy-key' });
  await credentials.collection.insertOne({ ownerId: legacyOwner, site: 'hdarea', encryptedCookie: 'legacy-cookie', version: 'legacy' });
  await assert.rejects(service.saveMTeam(winner, mtInput('account-2-key')), pending);
  await assert.rejects(hd.configure(hdWinner, 'hdarea', 'account-2-cookie'), pending);
  // Updating an already verified account remains possible while legacy identities are unresolved.
  await service.saveMTeam(loser, mtInput('account-1-key-update'));
  await hd.configure(hdLoser, 'hdarea', 'account-1-cookie-update');
});
