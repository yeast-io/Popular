import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { deleteUserData, parseDeleteUserArguments } from './delete-user.store.mjs';
import { userOwnedCollections } from './delete-user.policy.mjs';

function fixture() {
  const id = { toString: () => 'target-id' };
  const target = { _id: id, email: 'target@example.com', avatarObjectKey: 'users/target-id/avatars/avatar.png' };
  const rows = new Map([
    ['users', [target, { _id: 'other-id', email: 'other@example.com' }]],
    ['movies', [{ _id: 'shared-movie' }]],
    ...userOwnedCollections.map((name) => [name, [{ ownerId: id }, { ownerId: 'target-id' }, { ownerId: 'other-id' }]]),
  ]);
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
    return value && typeof value === 'object' && '$in' in value ? value.$in.includes(row[key]) : row[key] === value;
  });
  let failCollection;
  const database = {
    collection(name) {
      return {
        async findOne(filter) { return rows.get(name)?.find((row) => matches(row, filter)) ?? null; },
        async countDocuments(filter) { return (rows.get(name) ?? []).filter((row) => matches(row, filter)).length; },
        async deleteMany(filter) {
          if (name === failCollection) throw new Error('Simulated database failure');
          const before = rows.get(name) ?? [];
          const after = before.filter((row) => !matches(row, filter));
          rows.set(name, after);
          return { deletedCount: before.length - after.length };
        },
        async deleteOne(filter) { return this.deleteMany(filter); },
      };
    },
  };
  const pepper = 'test-pepper';
  const prefix = 'test:';
  const pendingKey = `${prefix}registration:email:pending:${createHmac('sha256', pepper).update('email\0target@example.com').digest('hex')}`;
  const keys = new Map([
    ['test:session:a', 'target-id'], ['test:session:b', 'other-id'],
    ['test:registration:email:quota', 'quota-untouched'], [pendingKey, 'pending-registration'],
    ['different-app:session:a', 'target-id'],
  ]);
  const deletedAvatars = [];
  const mutations = [];
  const redis = {
    async scan(cursor, _match, pattern) {
      assert.equal(pattern, 'test:session:*');
      return cursor === '0' ? ['1', ['test:session:a']] : ['0', ['test:session:a', 'test:session:b']];
    },
    async get(key) { return keys.get(key) ?? null; },
    async exists(key) { return Number(keys.has(key)); },
    async del(key) {
      mutations.push(key);
      return Number(keys.delete(key));
    },
    async eval(_script, _count, key, ownerId) {
      if (keys.get(key) === ownerId) return this.del(key);
      return 0;
    },
  };
  return { rows, keys, mutations, target, pendingKey, deletedAvatars,
    options: { database, redis, pepper, prefix, email: target.email, dryRun: false,
      avatars: { async delete(key) { deletedAvatars.push(key); } }, report() {},
    },
    fail: (name) => { failCollection = name; },
  };
}

test('email argument is normalized and invalid or extra arguments fail before connecting', () => {
  assert.deepEqual(parseDeleteUserArguments([' TARGET@Example.COM ', '--dry-run']), { email: 'target@example.com', dryRun: true });
  for (const args of [[], ['invalid'], ['a@example.com', 'b@example.com'], ['a@example.com', '--unknown']]) {
    assert.throws(() => parseDeleteUserArguments(args), /INVALID_ARGUMENTS/);
  }
});

test('deletion removes only target user data, including both owner ID types, and preserves the send quota', async () => {
  const f = fixture();
  const result = await deleteUserData(f.options);
  assert.equal(result.userDeleted, 1);
  assert.equal(result.sessions, 1);
  assert.equal(result.pendingRegistration, 1);
  for (const name of userOwnedCollections) assert.deepEqual(f.rows.get(name), [{ ownerId: 'other-id' }]);
  assert.equal(f.rows.get('users').length, 1);
  assert.deepEqual(f.rows.get('movies'), [{ _id: 'shared-movie' }]);
  assert.equal(f.keys.get('test:session:b'), 'other-id');
  assert.equal(f.keys.get('different-app:session:a'), 'target-id');
  assert.equal(f.keys.get('test:registration:email:quota'), 'quota-untouched');
  assert.deepEqual(f.deletedAvatars, ['users/target-id/avatars/avatar.png']);
  const repeat = await deleteUserData(f.options);
  assert.equal(repeat.userFound, false);
  assert.equal(repeat.pendingRegistration, 0);
});

test('dry-run counts records without any mutations or avatar deletion', async () => {
  const f = fixture();
  const result = await deleteUserData({ ...f.options, dryRun: true });
  assert.equal(result.userFound, true);
  assert.equal(result.userDeleted, 0);
  assert.equal(result.collections.auth_identities, 2);
  assert.equal(result.sessions, 1);
  assert.equal(result.pendingRegistration, 1);
  assert.equal(f.rows.get('users').length, 2);
  assert.equal(f.rows.get('auth_identities').length, 3);
  assert.deepEqual(f.mutations, []);
  assert.deepEqual(f.deletedAvatars, []);
});

test('pending-only registration is cleared even if no permanent user exists', async () => {
  const f = fixture();
  f.rows.set('users', [{ _id: 'other-id', email: 'other@example.com' }]);
  const result = await deleteUserData(f.options);
  assert.equal(result.userFound, false);
  assert.equal(result.pendingRegistration, 1);
  assert.equal(f.keys.get('test:registration:email:quota'), 'quota-untouched');
  assert.equal(f.keys.get('test:session:a'), 'target-id');
});

test('partial failure retains the user identity so retry completes cleanup', async () => {
  const f = fixture();
  f.fail('conversation_threads');
  await assert.rejects(deleteUserData(f.options), /Simulated database failure/);
  assert.equal(f.rows.get('users').length, 2);
  f.fail(undefined);
  assert.equal((await deleteUserData(f.options)).userDeleted, 1);
});

test('a foreign avatar path stops deletion before any data mutation', async () => {
  const f = fixture();
  f.target.avatarObjectKey = 'users/other-id/avatars/avatar.png';
  await assert.rejects(deleteUserData(f.options), /INVALID_AVATAR/);
  assert.equal(f.rows.get('auth_identities').length, 3);
  assert.deepEqual(f.mutations, []);
});
