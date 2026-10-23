import assert from 'node:assert/strict';
import test from 'node:test';
import pino from '../../apps/helpers/gateway/node_modules/pino/pino.js';
import { once } from 'node:events';
import WebSocket from '../../apps/helpers/gateway/node_modules/ws/wrapper.mjs';
import { CompactSign, compactVerify, compactDecrypt, importJWK } from '../../apps/helpers/gateway/node_modules/jose/dist/webapi/index.js';
import { createFixture, newDevice } from './fixture.mjs';
import { GatewayPool } from '../../apps/api/src/infrastructure/socket/gateway-pool.service.ts';
import { RemoteDownloadCoordinator } from '../../apps/api/src/modules/remote-downloads/remote-download-coordinator.service.ts';
import { createGatewayApp } from '../../apps/helpers/gateway/src/gateway.routes.ts';
import { GatewayService } from '../../apps/helpers/gateway/src/gateway.service.ts';
import { GatewayBridge } from '../../apps/helpers/gateway/src/infrastructure/gateway-bridge.service.ts';
import { RedisGatewayBus } from '../../apps/helpers/gateway/src/infrastructure/gateway-bus.service.ts';
import { RedisRouter } from '../../apps/helpers/gateway/src/infrastructure/redis-router.store.ts';
import { Redis } from '../../apps/helpers/gateway/node_modules/ioredis/built/index.js';

const diagnostics = { verbose: false, info() {}, error() {} };
async function ready(pool) {
  const deadline = Date.now() + 5000;
  while (pool.healthyCount !== 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(pool.healthyCount, 4);
}
async function host(t, gateway, bridge, backend) {
  const token = 'independent-test-service-credential-123456';
  const app = await createGatewayApp(gateway, token, { bridge, allowInsecureDev: true });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const pool = new GatewayPool({ urls: [address], token, instanceId: 'popular-test', size: 4, allowInsecure: true,
    diagnostics, handle: (c, p) => backend.handle(c, p) });
  t.after(async () => {
    await pool.stop();
    await app.close();
    await bridge.close();
  });
  pool.start();
  await ready(pool);
  return { pool, app, address };
}
test('REAL loopback WebSocket: four connections, concurrent bidirectional calls, readiness, immediate offline rejection', {
  skip: !process.env.GATEWAY_TEST_NETWORK, timeout: 15_000,
}, async (t) => {
  const f = await createFixture();
  f.options.popular = f.bridge;
  const { pool, app } = await host(t, f.gateway, f.bridge, f.backend);
  assert.equal((await app.inject('/health/ready')).statusCode, 200);
  const signing = await app.inject(
    { url: '/client/v1/signing-keys', headers: { authorization: 'Bearer fixture-api-key' } }
  );
  assert.equal(signing.statusCode, 200);
  const bad = await app.inject({ url: '/client/v1/signing-keys', headers: { authorization: 'Bearer wrong' } });
  assert.equal(bad.statusCode, 401);
  assert.equal((await app.inject('/internal/v1/downloads')).statusCode, 404);
  const d = await newDevice();
  const live = await f.connect(d);
  const results = await Promise.all(Array.from({ length: 32 }, () => {
    return pool.call('__get_device_status__', {
      ownerId: 'owner-1', deviceId: d.deviceId, authVersion: 1, deviceVersion: 1 }
    );
  })
  );
  assert.ok(results.every((r) => r.online));
  const coordinator = new RemoteDownloadCoordinator(pool, f.backend);
  const input = { commandId: 'tcp-1', downloadId: 'tcp-download', ownerId: 'owner-1', deviceId: d.deviceId, authVersion: 1,
    deviceVersion: 1, source: 'mteam', resourceId: 'release-1', correlationId: 'tcp-trace' };
  f.store.downloads.set(input.downloadId, { ...input, executionMode: 'remote', tmdbId: 1 });
  await coordinator.dispatch(input);
  assert.ok(live.sent.some((m) => m.command === '__add_download__'));
  await pool.stop();
  await assert.rejects(
    pool.call('__get_device_status__', {}),
    { code: 'GATEWAY_UNAVAILABLE', effect: 'not_applied' }
  );
});
test('REAL Redis + WebSocket, SIMULATED Mongo: service pool on one Gateway routes to Agent on another, no Pub/Sub dependency', {
  skip: !process.env.GATEWAY_TEST_REDIS_URL || !process.env.GATEWAY_TEST_NETWORK, timeout: 20_000,
}, async (t) => {
  const f = await createFixture();
  const prefix = 'gateway-network-test:' + crypto.randomUUID() + ':';
  const redis1 = new Redis(process.env.GATEWAY_TEST_REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  const redis2 = new Redis(process.env.GATEWAY_TEST_REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  const router1 = new RedisRouter(redis1, prefix, 45_000);
  const router2 = new RedisRouter(redis2, prefix, 45_000);
  await Promise.all([router1.ready(), router2.ready()]);
  const token = 'independent-test-service-credential-123456';
  const bus1 = new RedisGatewayBus(redis1, 'one', token, f.options.logger, prefix + 'relay:');
  const bus2 = new RedisGatewayBus(redis2, 'two', token, f.options.logger, prefix + 'relay:');
  const bridge1 = new GatewayBridge(bus1);
  const bridge2 = new GatewayBridge(bus2);
  const one = new GatewayService({ ...f.options, instanceId: 'one', router: router1, bus: bus1, popular: bridge1 });
  const two = new GatewayService({ ...f.options, instanceId: 'two', router: router2, bus: bus2, popular: bridge2 });
  await bus1.start(
    (kind, frame) => kind === 'popular' ? bridge1.relay(frame) : one.handleRpc(frame.command, frame.payload, frame)
  );
  await bus2.start(
    (kind, frame) => kind === 'popular' ? bridge2.relay(frame) : two.handleRpc(frame.command, frame.payload, frame)
  );
  const { pool } = await host(t, one, bridge1, f.backend);
  t.after(async () => {
    await bridge2.close();
    await bus1.close();
    await bus2.close();
    const keys = await redis1.keys(prefix + '*');
    if (keys.length) await redis1.del(...keys);
    await router1.close();
    await router2.close();
  });
  await bus1.subscriber.unsubscribe();
  await bus2.subscriber.unsubscribe();
  const d = await newDevice();
  const live = await f.connect(d, two);
  const input = { commandId: 'routed-1', downloadId: 'routed-download', ownerId: 'owner-1', deviceId: d.deviceId,
    authVersion: 1, deviceVersion: 1, source: 'mteam', resourceId: 'release-1', correlationId: 'cross-instance-trace' };
  f.store.downloads.set(input.downloadId, { ...input, tmdbId: 1, executionMode: 'remote' });
  const c = new RemoteDownloadCoordinator(pool, f.backend);
  await c.dispatch(input);
  assert.ok(live.sent.some((m) => m.command === '__add_download__'));
  assert.equal(f.store.commands.get(input.commandId).state, 'delivered');
  const fresh = await f.connect(d, one, false);
  await two.dropped(live.peer);
  assert.equal((await router2.get(d.deviceId)).sessionId, fresh.peer.session.sessionId);
});

test('REAL Agent WebSocket with SIMULATED Mongo/downloader: proof, encrypted delivery, grant, durable result and status ACK', {
  skip: !process.env.GATEWAY_TEST_NETWORK, timeout: 15_000,
}, async (t) => {
  const f = await createFixture();
  f.options.popular = f.bridge;
  const logs = [];
  f.options.logger = pino({ level: 'info' }, { write(text) {
    logs.push(JSON.parse(text));
  } });
  assert.equal(f.options.verbose, false);
  const { pool, address } = await host(t, f.gateway, f.bridge, f.backend);
  const d = await newDevice();
  const socket = new WebSocket(address.replace(
    'http:', 'ws:'
  ) + '/client/v1/socket', { headers: { authorization: 'Bearer fixture-api-key' } });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const request = async (command, payload) => {
    const response = once(socket, 'message');
    socket.send(
      JSON.stringify(
        { protocolVersion: 1, command, messageId: crypto.randomUUID(), correlationId: 'tcp-agent', payload }
      )
    );
    return JSON.parse((await response)[0].toString());
  };
  const challenge = await request('__authenticate__', { intent: 'bind', operationId: d.operationId, keys: d.keys });
  assert.equal(challenge.command, '__auth_challenge__');
  const proof = await new CompactSign(new TextEncoder().encode(challenge.payload.challenge)).setProtectedHeader(
    { alg: 'EdDSA' }
  ).sign(
    d.signer.privateKey
  );
  const auth = await request('__auth_proof__', { proof });
  assert.equal(auth.command, '__auth_result__');
  const context = auth.payload;
  socket.send(JSON.stringify({ protocolVersion: 1, command: '__agent_status__', messageId: 'agent-ready', payload: {
    downloaderType: 'qbittorrent', instanceId: 'downloader-1', configured: true, reachable: true } }
  )
  );
  const deadline = Date.now() + 3000;
  while (!(await pool.call(
    '__get_device_status__',
    { ownerId: context.ownerId, deviceId: context.deviceId, authVersion: 1, deviceVersion: 1 }
  )).agentStatus?.reachable) {
    assert.ok(Date.now() < deadline);
    await new Promise((r) => setTimeout(r, 10));
  }
  const input = { commandId: 'wire-command', downloadId: 'wire-download', ownerId: context.ownerId, deviceId: context.deviceId,
    authVersion: 1, deviceVersion: 1, source: 'mteam', resourceId: 'resource-1', correlationId: 'tcp-agent' };
  f.store.downloads.set(input.downloadId, { ...input, tmdbId: 1, executionMode: 'remote' });
  const delivery = once(socket, 'message');
  await new RemoteDownloadCoordinator(pool, f.backend).enqueue(input);
  const delivered = JSON.parse((await delivery)[0].toString());
  assert.equal(delivered.command, '__add_download__');
  const publicKey = await importJWK(f.options.signing.publicKey, 'EdDSA');
  const verified = await compactVerify(delivered.payload.envelope, publicKey);
  const wrapper = JSON.parse(new TextDecoder().decode(verified.payload));
  const clear = await compactDecrypt(wrapper.jwe, d.encryption.privateKey);
  const queuedPayload = JSON.parse(new TextDecoder().decode(clear.plaintext));
  assert.equal(queuedPayload.retryAttempt, 1);
  assert.equal(queuedPayload.queueExpiresAt - f.store.commands.get(input.commandId).createdAt, 7 * 86400000);
  assert.equal(JSON.parse(new TextDecoder().decode(clear.plaintext)).commandId, input.commandId);
  socket.send(
    JSON.stringify(
      { protocolVersion: 1, command: '__command_received__', messageId: 'wire-received', payload: { commandId: input.commandId } }
    )
  );
  const grant = await request('__request_execution__', { commandId: input.commandId, executionId: 'wire-execution' });
  assert.equal(grant.command, '__execution_granted__');
  const signed = await compactVerify(grant.payload.grant, publicKey);
  assert.equal(JSON.parse(new TextDecoder().decode(signed.payload)).executionId, 'wire-execution');
  const evidence = { ...f.evidence, marker: 'popular-wire-execution' };
  const result = await request(
    '__command_result__',
    { commandId: input.commandId, executionId: 'wire-execution', outcome: 'succeeded', evidence }
  );
  assert.equal(result.command, '__command_result_ack__');
  assert.equal(result.payload.persisted, true);
  const status = await request('__download_status__', { commandId: input.commandId, executionId: 'wire-execution', evidence, sequence: 1,
    state: 'completed', progress: 1, downloadedBytes: 100, totalBytes: 100, downloadSpeed: 0, uploadSpeed: 0 }
  );
  assert.equal(
    status.command, '__download_status_ack__'
  );
  assert.equal(
    f.store.downloads.get(input.downloadId).status.state, 'completed'
  );
  assert.equal(logs.filter((l) => l.stage === 'socket.connected' && l.clientType === 'popular').length, 4);
  const serviceReady = logs.filter((l) => l.stage === 'socket.authenticated' && l.clientType === 'popular');
  assert.equal(serviceReady.length, 4);
  assert.deepEqual(new Set(serviceReady.map((l) => l.poolSlotId)), new Set(['0', '1', '2', '3']));
  assert.ok(serviceReady.every((l) => l.popularInstanceId === 'popular-test' && l.connectionId && l.correlationId));
  const agentAuthenticated = logs.find((l) => l.stage === 'socket.authenticated' && l.clientType === 'agent');
  assert.equal(
    agentAuthenticated.deviceId, context.deviceId
  );
  assert.equal(
    agentAuthenticated.sessionId, context.sessionId
  );
  const closed = once(socket, 'close');
  socket.close(1000);
  await closed;
  const waitUntil = Date.now() + 3000;
  while (!logs.some(
    (l) => l.stage === 'socket.disconnected' && l.clientType === 'agent'
  ) && Date.now() < waitUntil) await new Promise((r) => {
    return setTimeout(r, 10);
  });
  const disconnected = logs.find((l) => l.stage === 'socket.disconnected' && l.clientType === 'agent');
  assert.equal(disconnected.closeCode, 1000);
  assert.equal(disconnected.connectionId, agentAuthenticated.connectionId);
  assert.equal(logs.some((l) => l.stage === 'rpc.request'), false);
  await pool.stop();
  const serviceDeadline = Date.now() + 3000;
  while (logs.filter(
    (l) => l.stage === 'socket.disconnected' && l.clientType === 'popular'
  ).length < 4 && Date.now() < serviceDeadline) await new Promise((r) => {
    return setTimeout(r, 10);
  });
  assert.equal(logs.filter((l) => l.stage === 'socket.disconnected' && l.clientType === 'popular').length, 4);
  const logText = JSON.stringify(logs);
  for (const secret of ['fixture-api-key', 'independent-test-service-credential-123456', 'SECRET', d.keys.encryptionKey.n, proof]) assert.equal(
    logText.includes(secret),
    false
  );
});
