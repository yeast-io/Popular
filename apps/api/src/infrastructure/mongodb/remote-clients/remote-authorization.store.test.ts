import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from 'mongoose';
import type { RemoteDeviceDocument } from './remote-authorization.schema.js';
import type { RemoteAuthorizationChange } from '@movie-hub/contract';
import type { UserDocument } from '../users/user.schema.js';
import { MongoRemoteAuthorizationStore } from './remote-authorization.store.js';

const keyEvent: RemoteAuthorizationChange = {
  scope: 'key',
  eventId: 'event-key',
  ownerId: 'owner',
  authVersion: 8,
  correlationId: 'trace',
};
const deviceEvent: RemoteAuthorizationChange = {
  scope: 'device',
  eventId: 'event-device',
  ownerId: 'owner',
  authVersion: 7,
  deviceId: 'device-a',
  deviceVersion: 4,
  correlationId: 'trace',
};
function models() {
  const userWrites: unknown[][] = [];
  const deviceWrites: unknown[][] = [];
  const users = {
    updateOne(...args: unknown[]) {
      userWrites.push(args);
      return {
        async exec() {
          return { modifiedCount: 1 };
        },
      };
    },
  } as unknown as Model<UserDocument>;
  const devices = {
    updateOne(...args: unknown[]) {
      deviceWrites.push(args);
      return {
        async exec() {
          return { modifiedCount: 1 };
        },
      };
    },
  } as unknown as Model<RemoteDeviceDocument>;
  return { userWrites, deviceWrites, store: new MongoRemoteAuthorizationStore(users, devices) };
}

test('device unbind changes only the named owner/device binding and never writes user RCCK fields', async () => {
  const f = models();
  assert.equal(
    await f.store.unbind(
      'owner',
      'device-a',
      { operationId: 'op', expectedAuthVersion: 7, expectedDeviceVersion: 3 },
      deviceEvent
    ),
    true
  );
  assert.equal(f.userWrites.length, 0);
  const [filter, update, options] = f.deviceWrites[0]! as [Record<string, unknown>, Record<string, unknown>, unknown];
  assert.deepEqual(filter, {
    'ownerId': 'owner',
    'deviceId': 'device-a',
    'authVersion': 7,
    'deviceVersion': 3,
    'status': 'bound',
    'operations.operationId': { $ne: 'op' },
  }
  );
  assert.deepEqual(update.$inc, { deviceVersion: 1 });
  assert.equal((update.$set as Record<string, unknown>).status, 'unbound');
  assert.deepEqual((update.$set as Record<string, unknown>).pendingGatewayChange, deviceEvent);
  assert.deepEqual(options, { runValidators: true });
  assert.equal('authVersion' in (update.$inc as Record<string, unknown>), false);
});

test('key revocation is one CAS update on the existing user; removes encrypted secret and never rewrites devices', async () => {
  const f = models();
  assert.equal(
    await f.store.changeKey('owner', 'revoke', { operationId: 'op', expectedAuthVersion: 7 }, undefined, keyEvent),
    true
  );
  assert.equal(f.deviceWrites.length, 0);
  const [filter, update] = f.userWrites[0]! as [Record<string, unknown>, Record<string, unknown>];
  assert.deepEqual(filter, {
    '_id': 'owner',
    'rcck.authVersion': 7,
    'rcck.active': true,
    'rcck.operations.operationId': { $ne: 'op' },
  }
  );
  assert.deepEqual(update.$inc, { 'rcck.authVersion': 1 });
  assert.deepEqual(update.$unset, { 'rcck.encryptedKey': 1 });
  assert.equal((update.$set as Record<string, unknown>)['rcck.active'], false);
  assert.deepEqual((update.$set as Record<string, unknown>)['rcck.pendingGatewayChange'], keyEvent);
  assert.equal('email' in (update.$set as Record<string, unknown>), false);
});

test('initial RCCK generation uses existing owner _id and absent-key condition; secrets are already ciphertext', async () => {
  const f = models();
  await f.store.changeKey(
    'owner',
    'generate',
    { operationId: 'op', expectedAuthVersion: 0 },
    { keyDigest: 'a'.repeat(64), encryptedKey: 'v1.ciphertext' },
    { ...keyEvent, authVersion: 1 }
  );
  const [filter, update, options] = f.userWrites[0]! as [
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
  ];
  assert.equal(filter._id, 'owner');
  assert.deepEqual(filter.rcck, { $exists: false });
  assert.equal(options.upsert, undefined);
  assert.equal((update.$set as Record<string, unknown>)['rcck.encryptedKey'], 'v1.ciphertext');
  assert.equal('passwordHash' in (update.$set as Record<string, unknown>), false);
});

test('notification clearing is scoped to owner, key/device version and durable event identity', async () => {
  const f = models();
  await f.store.acknowledge(keyEvent);
  await f.store.acknowledge(deviceEvent);
  assert.deepEqual(f.userWrites[0]![0], {
    '_id': 'owner',
    'rcck.pendingGatewayChange.eventId': 'event-key',
    'rcck.pendingGatewayChange.authVersion': 8,
  }
  );
  assert.deepEqual(f.deviceWrites[0]![0], {
    'ownerId': 'owner',
    'deviceId': 'device-a',
    'pendingGatewayChange.eventId': 'event-device',
    'pendingGatewayChange.deviceVersion': 4,
  }
  );
});
