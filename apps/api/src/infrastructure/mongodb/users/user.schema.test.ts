import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from 'mongoose';
import { createUserModel } from './user.schema.js';

test('existing users model composes the canonical hidden RCCK fields and preserves user identity/profile indexes', () => {
  const users = createUserModel(createConnection());
  assert.equal(users.collection.name, 'users');
  assert.equal(users.schema.path('ownerId'), undefined);
  assert.equal(users.schema.path('rcck').options.select, false);
  assert.equal(users.schema.path('passwordHash').options.select, false);
  const user = new users({ email: 'owner@example.test', displayName: 'Owner' });
  assert.equal(user.rcck, undefined);
  assert.equal(user.remoteDeviceLimit, 1);
  assert.equal(user.validateSync(), undefined);
  assert.ok(users.schema.indexes().some(([fields, options]) => fields.email === 1 && options.unique));
  assert.ok(users.schema.indexes().some(([fields, options]) => fields['rcck.keyDigest'] === 1 && options.unique));
});
