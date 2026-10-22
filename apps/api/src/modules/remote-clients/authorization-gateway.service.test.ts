import assert from 'node:assert/strict';
import test from 'node:test';
import type { RpcCaller } from '@movie-hub/contract/socket-rpc';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import { AuthorizationGatewayClient } from './authorization-gateway.service.js';

test('Socket authorization notifications preserve event and correlation identities on retry', async () => {
  const calls: unknown[][] = [];
  const gateway: RpcCaller = {
    async call<T>(...args: Parameters<RpcCaller['call']>) {
      calls.push(args);
      return { applied: true, eventId: 'event-1' } as T;
    },
  };
  const event = {
    scope: 'key' as const,
    eventId: 'event-1',
    ownerId: 'owner-1',
    authVersion: 3,
    correlationId: 'trace-1',
  };
  const client = new AuthorizationGatewayClient(gateway);
  await client.notify(event);
  await client.notify(event);
  assert.deepEqual(calls, [
    ['__authorization_changed__', event, 'trace-1', 'event-1'],
    ['__authorization_changed__', event, 'trace-1', 'event-1'],
  ]
  );
});

test('Socket notifications reject wrong event acknowledgements and preserve uncertain failures', async () => {
  const event = {
    scope: 'device' as const,
    eventId: 'event',
    ownerId: 'owner',
    authVersion: 1,
    deviceId: 'device-1',
    deviceVersion: 2,
    correlationId: 'trace',
  };
  for (const ack of [
    { applied: false, eventId: 'event' },
    { applied: true, eventId: 'other' },
  ]) {
    await assert.rejects(
      new AuthorizationGatewayClient({
        async call<T>() {
          return ack as T;
        },
      }).notify(event),
      { code: 'INVALID_GATEWAY_ACK' }
    );
  }
  const error = new RpcError('RPC_TIMEOUT');
  await assert.rejects(
    new AuthorizationGatewayClient({
      async call() {
        throw error;
      },
    }).notify(event),
    (e) => e === error
  );
});
