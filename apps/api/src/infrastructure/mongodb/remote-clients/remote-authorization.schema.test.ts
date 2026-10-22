import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from 'mongoose';
import { createRemoteAuthorizationModel, remoteAuthorizationSchema } from './remote-authorization.schema.js';

test('legacy authorization model owns collection, unique identities and hides digest/device keys', () => {
  const connection = createConnection();
  const model = createRemoteAuthorizationModel(connection);
  assert.equal(createRemoteAuthorizationModel(connection), model);
  assert.equal(model.collection.name, 'remote_client_authorizations');
  const indexes = remoteAuthorizationSchema.indexes();
  assert.ok(indexes.some(([fields, options]) => fields.ownerId === 1 && options.unique));
  assert.ok(indexes.some(([fields, options]) => fields.keyDigest === 1 && options.unique));
  assert.ok(
    indexes.some(([fields, options]) => fields.deviceId === 1 && options.unique && options.partialFilterExpression)
  );
  assert.equal(remoteAuthorizationSchema.path('keyDigest').options.select, false);
  assert.equal(remoteAuthorizationSchema.path('keys').options.select, false);
  const row = new model({
    ownerId: '507f1f77bcf86cd799439011',
    keyDigest: 'a'.repeat(64),
    authVersion: 1,
    lastOperationId: 'op-1',
    lastOperationKind: 'generate',
    lastExpectedAuthVersion: 0,
  });
  assert.equal(row.validateSync(), undefined);
  assert.equal(row.active, true);
  assert.equal(row.deviceId, undefined);
  assert.equal(row.keys, undefined);
  assert.equal(remoteAuthorizationSchema.path('apiKey'), undefined);
});

test('RCCK belongs to users, is hidden by default, and its digest is globally unique without an owner/device singleton', async () => {
  const { createUserModel } = await import('../users/user.schema.js');
  const { createRemoteDeviceModel } = await import('./remote-device.schema.js');
  const connection = createConnection();
  const users = createUserModel(connection);
  assert.equal(users.collection.name, 'users');
  assert.equal(users.schema.path('rcck').options.select, false);
  assert.equal(users.schema.path('rcck.deviceId'), undefined);
  assert.equal(new users().remoteDeviceLimit, 1);
  const index = users.schema.indexes().find(([fields]) => fields['rcck.keyDigest'] === 1);
  assert.equal(index?.[1].unique, true);
  assert.ok(index?.[1].partialFilterExpression);
  const devices = createRemoteDeviceModel(connection);
  assert.equal(devices.collection.name, 'remote_client_devices');
  assert.equal(devices.schema.path('keys').options.select, false);
  assert.equal(devices.schema.path('encryptedKey'), undefined);
  assert.ok(
    !devices.schema
      .indexes()
      .some(
        ([fields, options]) => Object.keys(fields).length === 1 && fields.ownerId === 1 && options.unique
      )
  );
  const slotIndex = devices.schema
    .indexes()
    .find(
      ([fields]) => fields.ownerId === 1 && fields.authVersion === 1 && fields.slot === 1
    );
  assert.equal(slotIndex?.[1].unique, true);
  assert.deepEqual(slotIndex?.[1].partialFilterExpression, { status: 'bound' });
});

test('device public key identity is canonical and unique within a current account generation', async () => {
  const { remoteDeviceKeyFingerprint } = await import('./remote-device.domain.js');
  const { remoteDeviceSchema } = await import('./remote-device.schema.js');
  assert.equal(
    remoteDeviceKeyFingerprint({ signingKey: { x: 'x', kty: 'OKP' }, encryptionKey: { n: 'n' } }),
    remoteDeviceKeyFingerprint({ encryptionKey: { n: 'n' }, signingKey: { kty: 'OKP', x: 'x' } })
  );
  const index = remoteDeviceSchema
    .indexes()
    .find(
      ([fields]) => fields.keyFingerprint === 1 && fields.ownerId === 1 && fields.authVersion === 1
    );
  assert.equal(index?.[1].unique, true);
  assert.deepEqual(index?.[1].partialFilterExpression, { status: 'bound' });
});
