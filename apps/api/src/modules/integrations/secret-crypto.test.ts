import assert from 'node:assert/strict';
import test from 'node:test';
import { SecretCrypto } from './secret-crypto.js';

const key = 'test-integration-secret-key-that-is-long-enough';
const ownerContext = 'movie-hub:integration:mteam:owner:507f1f77bcf86cd799439011';

test('encrypts the same API key to different authenticated ciphertexts', () => {
  const crypto = new SecretCrypto(key);
  const first = crypto.encrypt('top-secret', ownerContext);
  const second = crypto.encrypt('top-secret', ownerContext);

  assert.notEqual(first, second);
  assert.equal(first.includes('top-secret'), false);
  assert.equal(crypto.decrypt(first, ownerContext), 'top-secret');
  assert.equal(crypto.decrypt(second, ownerContext), 'top-secret');
});

test('rejects ciphertext moved to another owner, tampered ciphertext, or the wrong key', () => {
  const crypto = new SecretCrypto(key);
  const encrypted = crypto.encrypt('top-secret', ownerContext);
  const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('A') ? 'B' : 'A'}`;

  assert.throws(() => crypto.decrypt(encrypted, `${ownerContext}-other`));
  assert.throws(() => crypto.decrypt(tampered, ownerContext));
  assert.throws(() => new SecretCrypto('another-integration-secret-key-that-is-long-enough').decrypt(encrypted, ownerContext));
});
