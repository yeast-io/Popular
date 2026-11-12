import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from 'mongoose';
import { createConnection } from 'mongoose';
import { MongoResourceSiteCredentialStore } from './resource-site-credential.store.js';
import { createResourceSiteCredentialModel } from './resource-site-credential.schema.js';
import type { ResourceSiteCredentialDocument } from './resource-site-credential.schema.js';

test('saving an API Key atomically removes legacy Cookie and Passkey fields without releasing the account binding', async () => {
  const updates: unknown[][] = [];
  const store = new MongoResourceSiteCredentialStore({
    exists: async () => ({ _id: 'existing' }),
    updateOne: (...args: unknown[]) => {
      updates.push(args);
      return { exec: async () => ({}) };
    },
  } as unknown as Model<ResourceSiteCredentialDocument>);
  const input = {
    ownerId: 'owner',
    site: 'hdarea',
    externalUserId: '123',
    encryptedApiKey: 'ciphertext',
    version: 'new-version',
    status: 'configured_valid' as const,
    verifiedAt: new Date(),
  };
  await store.save(input);
  assert.deepEqual(updates[0], [
    { ownerId: 'owner', site: 'hdarea' },
    { $set: input, $unset: { encryptedCookie: 1, encryptedPasskey: 1 } },
    { upsert: true },
  ]);
});

test('both legacy Cookies and API Keys remain excluded from default Mongo projections', () => {
  const connection = createConnection();
  const model = createResourceSiteCredentialModel(connection);
  assert.equal(model.schema.path('encryptedApiKey').options.select, false);
  assert.equal(model.schema.path('encryptedCookie').options.select, false);
  assert.ok(
    model.schema.indexes().some(([index, options]) => index.site === 1 && index.externalUserId === 1 && options.unique)
  );
  assert.equal(model.collection.name, 'resource_site_credentials');
});
