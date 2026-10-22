import assert from 'node:assert/strict';
import test from 'node:test';
import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { RemoteAuthorizationChangeSchema, RemoteClientConfigurationSchema, RemoteClientMutationSchema, RemoteClientUnbindSchema } from './remote-client.schema.js';

FormatRegistry.Set('date-time', (value) => !Number.isNaN(Date.parse(value)));
FormatRegistry.Set('uuid', (value) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value));

test('remote configuration lists independent devices and reports repeatable key availability without embedding secrets', () => {
  const configuration = { hasKey: true, canReadKey: true, authVersion: 1, deviceLimit: 3,
    devices: ['a', 'b', 'c'].map(
      (id) => ({ id, authVersion: 1, deviceVersion: 1, boundAt: '2026-10-21T00:00:00Z' })
    ), gatewayNotificationPending: false };
  assert.equal(Value.Check(RemoteClientConfigurationSchema, configuration), true);
  assert.equal(
    Value.Check(RemoteClientConfigurationSchema, { ...configuration, apiKey: 'must-not-be-metadata' }),
    false
  );
  assert.equal(
    Value.Check(RemoteClientConfigurationSchema, { ...configuration, device: { id: 'legacy-singleton' } }),
    false
  );
});

test('key mutation and per-device unbind have separate optimistic version requirements', () => {
  const input = { operationId: '00000000-0000-4000-8000-000000000001', expectedAuthVersion: 1 };
  assert.equal(Value.Check(RemoteClientUnbindSchema, { ...input, expectedDeviceVersion: 1 }), true);
  assert.equal(Value.Check(RemoteClientUnbindSchema, input), false);
  assert.equal(Value.Check(RemoteClientUnbindSchema, { ...input, expectedDeviceVersion: 0 }), false);
  assert.equal(Value.Check(RemoteClientMutationSchema, { ...input, expectedDeviceVersion: 1 }), false);
});

test('Gateway authorization events distinguish key-wide changes from one device and reject ambiguous payloads', () => {
  const base = { eventId: 'event', ownerId: 'owner', authVersion: 3, correlationId: 'trace' };
  assert.equal(Value.Check(RemoteAuthorizationChangeSchema, { ...base, scope: 'key' }), true);
  assert.equal(
    Value.Check(RemoteAuthorizationChangeSchema, { ...base, scope: 'device', deviceId: 'device', deviceVersion: 2 }),
    true
  );
  assert.equal(Value.Check(RemoteAuthorizationChangeSchema, { ...base, scope: 'device' }), false);
  assert.equal(
    Value.Check(RemoteAuthorizationChangeSchema, { ...base, scope: 'key', deviceId: 'device', deviceVersion: 2 }),
    false
  );
  assert.equal(Value.Check(RemoteAuthorizationChangeSchema, base), false);
});
