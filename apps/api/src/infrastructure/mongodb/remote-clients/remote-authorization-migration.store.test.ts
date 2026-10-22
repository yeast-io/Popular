import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from 'mongoose';
import type { RemoteAuthorizationDocument, RemoteDeviceDocument } from './remote-authorization.schema.js';
import type { UserDocument } from '../users/user.schema.js';
import { MongoRemoteAuthorizationMigration } from './remote-authorization-migration.store.js';

type Snapshot = Record<string, unknown>;
function fixture() {
  const user: Snapshot = {
    _id: 'owner',
    email: 'owner@example.test',
    displayName: 'Keep this profile',
    passwordHash: 'unchanged',
  };
  const old: Snapshot = {
    _id: 'legacy-id',
    ownerId: 'owner',
    authVersion: 7,
    active: true,
    keyDigest: 'a'.repeat(64),
    deviceId: 'device-a',
    keys: {
      signingKey: { kty: 'OKP', crv: 'Ed25519', x: 'public-x' },
      encryptionKey: { kty: 'RSA', n: 'public-n', e: 'AQAB' },
    },
    boundAt: new Date('2026-10-20T00:00:00Z'),
    createdAt: new Date('2026-10-19T00:00:00Z'),
    operations: [
      { operationId: 'first', kind: 'generate', expectedAuthVersion: 0 },
      { operationId: 'old-unbind', kind: 'unbind', expectedAuthVersion: 5 },
    ],
    pendingGatewayVersion: 7,
    pendingCorrelationId: 'original-correlation',
    lastOperationId: 'last-op',
  };
  const devices = new Map<string, Snapshot>();
  let failLegacyUpdate = false;
  let missingUser = false;
  const users = {
    findById() {
      const query = {
        select() {
          return query;
        },
        lean() {
          return query;
        },
        async exec() {
          return missingUser ? null : structuredClone(user);
        },
      };
      return query;
    },
    updateOne(_filter: Snapshot, update: { $set: Snapshot }) {
      return {
        async exec() {
          if (!user.rcck) {
            user.rcck = structuredClone(update.$set.rcck);
            return { matchedCount: 1 };
          }
          return { matchedCount: 0 };
        },
      };
    },
  } as unknown as Model<UserDocument>;
  const bindings = {
    updateOne(filter: Snapshot, update: { $setOnInsert?: Snapshot; $set?: Snapshot }) {
      return {
        async exec() {
          const existing = devices.get(String(filter.deviceId));
          if (existing && (existing.ownerId !== filter.ownerId || existing.authVersion !== filter.authVersion))
            throw Object.assign(new Error('duplicate device identity'), { code: 11000 });
          if (update.$set && existing && existing.status === filter.status) {
            Object.assign(existing, update.$set);
            existing.deviceVersion = Number(existing.deviceVersion) + 1;
          }
          if (!existing && update.$setOnInsert)
            devices.set(String(filter.deviceId), structuredClone(update.$setOnInsert));
          return { matchedCount: existing ? 1 : 0 };
        },
      };
    },
  } as unknown as Model<RemoteDeviceDocument>;
  const legacy = {
    find() {
      const query = {
        select() {
          return query;
        },
        lean() {
          return query;
        },
        async* cursor() {
          if (!old.migratedToUsers) yield structuredClone(old);
        },
      };
      return query;
    },
    updateOne(_filter: Snapshot, update: { $set: Snapshot }) {
      return {
        async exec() {
          if (failLegacyUpdate) throw new Error('interrupted after user write');
          Object.assign(old, structuredClone(update.$set));
          return { matchedCount: 1 };
        },
      };
    },
  } as unknown as Model<RemoteAuthorizationDocument>;
  return {
    user,
    old,
    devices,
    migration: new MongoRemoteAuthorizationMigration(users, bindings, legacy),
    fail(value: boolean) {
      failLegacyUpdate = value;
    },
    missingUser(value: boolean) {
      missingUser = value;
    },
  };
}

test('migrates legacy RCCK and device separately, keeps profile data and pending notification, disables old authority, and is idempotent', async () => {
  const f = fixture();
  assert.equal(await f.migration.migrate(), 1);
  const key = f.user.rcck as Snapshot;
  assert.equal(key.keyDigest, 'a'.repeat(64));
  assert.equal(key.authVersion, 7);
  assert.equal(key.active, true);
  assert.equal(key.encryptedKey, undefined);
  assert.deepEqual(key.operations, [{ operationId: 'first', kind: 'generate', expectedAuthVersion: 0 }]);
  assert.equal((key.pendingGatewayChange as Snapshot).scope, 'key');
  assert.equal((key.pendingGatewayChange as Snapshot).correlationId, 'original-correlation');
  assert.equal(f.user.passwordHash, 'unchanged');
  assert.equal(f.user.displayName, 'Keep this profile');
  const device = f.devices.get('device-a')!;
  assert.equal(device.ownerId, 'owner');
  assert.equal(device.authVersion, 7);
  assert.equal(device.deviceVersion, 1);
  assert.equal(device.slot, 1);
  assert.equal(device.status, 'bound');
  assert.deepEqual(device.keys, f.old.keys);
  assert.equal(f.old.active, false);
  assert.equal(f.old.migratedToUsers, true);
  assert.equal(await f.migration.migrate(), 0);
});

test('retry after a partial migration never overwrites a newer user key or an already unbound device', async () => {
  const f = fixture();
  f.fail(true);
  await assert.rejects(f.migration.migrate(), /interrupted after user write/);
  assert.ok(f.user.rcck);
  assert.equal(f.old.active, true);
  const key = f.user.rcck as Snapshot;
  key.encryptedKey = 'v1.new-ciphertext';
  f.devices.get('device-a')!.status = 'unbound';
  f.fail(false);
  assert.equal(await f.migration.migrate(), 1);
  assert.equal((f.user.rcck as Snapshot).encryptedKey, 'v1.new-ciphertext');
  assert.equal(f.devices.get('device-a')!.status, 'unbound');
});

test('an existing independent RCCK prevents attaching a legacy device even if version numbers happen to match', async () => {
  const f = fixture();
  f.user.rcck = {
    keyDigest: 'b'.repeat(64),
    authVersion: 7,
    active: true,
    encryptedKey: 'existing-ciphertext',
    operations: [],
  };
  await f.migration.migrate();
  assert.equal(f.devices.size, 0);
  assert.equal((f.user.rcck as Snapshot).keyDigest, 'b'.repeat(64));
  assert.equal(f.old.active, false);
});

test('missing owners, missing bound public keys and cross-owner device conflicts stop without inventing or overwriting data', async () => {
  const absent = fixture();
  absent.missingUser(true);
  await assert.rejects(absent.migration.migrate(), /owner is missing/);
  assert.equal(absent.user.rcck, undefined);
  assert.equal(absent.old.active, true);
  const noKeys = fixture();
  delete noKeys.old.keys;
  await assert.rejects(noKeys.migration.migrate(), /keys are missing/);
  assert.equal(noKeys.user.rcck, undefined);
  const conflict = fixture();
  conflict.devices.set('device-a', { ownerId: 'someone-else', authVersion: 7 });
  await assert.rejects(conflict.migration.migrate(), /duplicate device identity/);
  assert.equal(conflict.user.rcck, undefined);
  assert.equal(conflict.devices.get('device-a')!.ownerId, 'someone-else');
});

test('an independent RCCK invalidates a leftover old binding from an interrupted migration without affecting other devices', async () => {
  const f = fixture();
  f.user.rcck = {
    keyDigest: 'b'.repeat(64),
    authVersion: 7,
    active: true,
    encryptedKey: 'existing-ciphertext',
    operations: [],
  };
  f.devices.set('device-a', { ownerId: 'owner', authVersion: 7, deviceVersion: 1, status: 'bound' });
  f.devices.set('other-device', { ownerId: 'owner', authVersion: 7, deviceVersion: 1, status: 'bound' });
  await f.migration.migrate();
  assert.equal(f.devices.get('device-a')!.status, 'unbound');
  assert.equal(f.devices.get('device-a')!.deviceVersion, 2);
  assert.equal(f.devices.get('other-device')!.status, 'bound');
});
