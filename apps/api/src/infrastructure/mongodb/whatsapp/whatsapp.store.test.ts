import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoWhatsAppStore } from './whatsapp.store.js';
import { SecretCrypto } from '../../../modules/integrations/secret-crypto.js';

test('auth state is encrypted and bound to owner; all reads/writes require an unexpired matching lease', async () => {
  let ciphertext = '';
  const filters: Array<Record<string, unknown>> = [];
  const model = {
    updateOne: (filter: Record<string, unknown>, update: { $set?: { encryptedState?: string } }) => {
      filters.push(filter);
      if (update.$set?.encryptedState) ciphertext = update.$set.encryptedState;
      return { exec: async () => ({ matchedCount: 1 }) };
    },
    findOne: (filter: Record<string, unknown>) => {
      filters.push(filter);
      return { select: () => ({ lean: () => ({ exec: async () => ({ encryptedState: ciphertext }) }) }) };
    },
  };
  const store = new MongoWhatsAppStore(model as never, new SecretCrypto('test-whatsapp-encryption-key-at-least-32-characters'));
  const plaintext = JSON.stringify({ creds: { secret: 'alice-private-credential' }, keys: { secret: 'signal-private-key' } });
  await store.save('alice', 'lease-alice', plaintext);
  assert.ok(ciphertext.startsWith('v1.'));
  assert.ok(!ciphertext.includes('alice-private-credential'));
  assert.equal(await store.load('alice', 'lease-alice'), plaintext);
  // Copying an encrypted session into another user's document cannot decrypt it.
  await assert.rejects(() => store.load('bob', 'lease-bob'));
  await store.clear('alice', 'lease-alice');
  for (const filter of filters) {
    assert.ok(filter.ownerId === 'alice' || filter.ownerId === 'bob');
    assert.equal(filter.leaseId, filter.ownerId === 'alice' ? 'lease-alice' : 'lease-bob');
    assert.ok((filter.leaseUntil as { $gt: Date }).$gt instanceof Date);
  }
});

test('a stale process cannot overwrite or clear a newer lease session', async () => {
  const model = { updateOne: () => ({ exec: async () => ({ matchedCount: 0 }) }) };
  const store = new MongoWhatsAppStore(model as never, new SecretCrypto('test-whatsapp-encryption-key-at-least-32-characters'));
  await assert.rejects(() => store.save('alice', 'expired-lease', 'private-state'), /lease lost/);
  await assert.rejects(() => store.clear('alice', 'expired-lease'), /lease lost/);
  assert.equal(await store.renew('alice', 'expired-lease'), false);
});
