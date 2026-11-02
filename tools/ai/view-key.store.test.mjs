import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { parseViewKeyArguments, readAccountKey } from './view-key.store.mjs';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
require('tsx/esm/api').register();
const { SecretCrypto } = await import('../../apps/api/src/modules/integrations/secret-crypto.ts');
const secrets = new SecretCrypto('test-only-integration-key-at-least-32-characters');
const alice = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const bob = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function databaseFor({ provider, ownerId = alice, record, legacy = null, users = [{ _id: alice }] }) {
  const reads = [];
  const database = { collection(name) {
    // Only read methods exist. Migration, update, insert and delete attempts fail the test.
    return {
      find(filter) {
        assert.equal(name, 'users');
        assert.deepEqual(filter, { email: 'alice@example.com' });
        return { limit(count) {
          assert.equal(count, 2);
          return { toArray: async () => users };
        } };
      },
      async findOne(filter) {
        reads.push(name);
        assert.equal(filter.ownerId, ownerId);
        if (name === 'ai_configs') {
          assert.equal(filter.provider, provider);
          return record;
        }
        assert.equal(name, 'openai_configs');
        assert.equal(provider, 'openai');
        return legacy;
      },
    };
  } };
  return { database, reads };
}

test('requires exactly one explicit account selector and validates providers/options', () => {
  assert.deepEqual(parseViewKeyArguments(['deepseek', '--email', 'Alice@Example.com']), {
    provider: 'deepseek', email: 'alice@example.com', ownerId: undefined, locale: 'zh-CN',
  });
  assert.equal(parseViewKeyArguments(['openai', '--owner-id', alice, '--locale', 'en-US']).ownerId, alice);
  for (const args of [[], ['deepseek'], ['unknown', '--owner-id', alice],
    ['claude', '--email', 'alice@example.com', '--owner-id', alice], ['openai', '--owner-id', 'bad'],
    ['deepseek', '--email', 'alice@example.com', '--email', 'bob@example.com'],
    ['deepseek', '--email', 'alice@example.com', '--all'], ['deepseek', '--email', 'bad']])
    assert.throws(() => parseViewKeyArguments(args), /INVALID_ARGUMENTS/);
});

test('decrypts each provider only for the selected account', async () => {
  for (const provider of ['deepseek', 'openai', 'claude']) {
    const key = `test-only-${provider}-key`;
    const encryptedApiKey = secrets.encrypt(key, `movie-hub:integration:${provider}:owner:${alice}`);
    const { database } = databaseFor({ provider, record: { encryptedApiKey } });
    assert.equal(await readAccountKey({ database, secrets, provider, userFilter: { email: 'alice@example.com' } }), key);
    const other = databaseFor({ provider, record: { encryptedApiKey }, ownerId: bob, users: [{ _id: bob }] });
    await assert.rejects(readAccountKey({ database: other.database, secrets, provider,
      userFilter: { email: 'alice@example.com' } }), /DECRYPT_FAILED/);
  }
});

test('legacy OpenAI fallback is read only and deleted/new records suppress it', async () => {
  const legacy = { encryptedApiKey: secrets.encrypt('test-only-legacy-key', `movie-hub:integration:openai:owner:${alice}`) };
  const old = databaseFor({ provider: 'openai', record: null, legacy });
  assert.equal(await readAccountKey({ database: old.database, secrets, provider: 'openai',
    userFilter: { email: 'alice@example.com' } }), 'test-only-legacy-key');
  assert.deepEqual(old.reads, ['ai_configs', 'openai_configs']);
  for (const record of [{ removed: true }, {}]) {
    const current = databaseFor({ provider: 'openai', record, legacy });
    await assert.rejects(readAccountKey({ database: current.database, secrets, provider: 'openai',
      userFilter: { email: 'alice@example.com' } }), /KEY_NOT_FOUND/);
    assert.deepEqual(current.reads, ['ai_configs']);
  }
});

test('missing or ambiguous users fail before credentials are read', async () => {
  for (const users of [[], [{ _id: alice }, { _id: bob }]]) {
    const { database, reads } = databaseFor({ provider: 'deepseek', users });
    await assert.rejects(readAccountKey({ database, secrets, provider: 'deepseek',
      userFilter: { email: 'alice@example.com' } }), users.length ? /AMBIGUOUS_USER/ : /USER_NOT_FOUND/);
    assert.deepEqual(reads, []);
  }
});
