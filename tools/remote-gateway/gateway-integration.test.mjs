import assert from 'node:assert/strict';
import test from 'node:test';
import { compactVerify, compactDecrypt, importJWK } from '../../apps/helpers/gateway/node_modules/jose/dist/webapi/index.js';
import { createFixture, newDevice, message } from './fixture.mjs';
import { GatewayService } from '../../apps/helpers/gateway/src/gateway.service.ts';
import { RemoteDownloadService } from '../../apps/api/src/modules/remote-downloads/remote-download.service.ts';

test('SIMULATED Mongo: invalid API key/proof, explicit atomic binding and current ownership', async () => {
  const f = await createFixture();
  const d = await newDevice();
  await assert.rejects(f.gateway.signingKeys('invalid'), { code: 'INVALID_API_KEY' });
  assert.equal((await f.gateway.signingKeys('fixture-api-key')).keys.length, 1);
  const bad = { id: 'bad', digest: f.store.accounts.get('owner-1').keyDigest, send() {}, close() {} };
  await f.gateway.message(
    bad,
    message('__authenticate__', { keys: d.keys, intent: 'bind', operationId: d.operationId })
  );
  await assert.rejects(
    f.gateway.message(bad, message('__auth_proof__', { proof: 'invalid' })),
    { code: 'INVALID_DEVICE_PROOF' }
  );
  assert.equal(f.store.devices.size, 0);
  const other = await newDevice();
  const results = await Promise.allSettled([f.connect(d), f.connect(other)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(f.store.devices.size, 1);
  const live = results.find((r) => r.status === 'fulfilled').value;
  assert.equal(live.peer.session.ownerId, 'owner-1');
  await assert.rejects(f.prepare({ session: { ...live.peer.session, ownerId: 'forged' } }), { code: 'DEVICE_OFFLINE' });
});

test('SIMULATED Mongo: session takeover, old cleanup, revocation without notification, no offline replay', async () => {
  const f = await createFixture();
  const d = await newDevice();
  const old = await f.connect(d);
  const input = await f.prepare(old.peer);
  const nextGateway = new GatewayService({ ...f.options, instanceId: 'gateway-2' });
  const fresh = await f.connect(d, nextGateway, false);
  await assert.rejects(
    f.gateway.message(
      old.peer,
      message(
        '__agent_status__',
        { downloaderType: 'qbittorrent', instanceId: 'old', configured: true, reachable: true }
      )
    ),
    { code: 'SESSION_REVOKED' }
  );
  await f.gateway.dropped(old.peer);
  assert.equal((await f.gatewayCoordinator.get(d.deviceId)).sessionId, fresh.peer.session.sessionId);
  await nextGateway.pump(d.deviceId);
  assert.equal(fresh.sent.some((m) => m.command === '__add_download__'), false);
  await f.gatewayCoordinator.release(fresh.peer.session);
  const count = f.store.commands.size;
  await assert.rejects(
    f.coordinator.dispatch({ ...input, commandId: 'offline', downloadId: 'offline-download' }),
    { code: 'DEVICE_OFFLINE' }
  );
  assert.equal(f.store.commands.size, count);
  await f.gatewayCoordinator.claim(fresh.peer.session);
  f.store.devices.get(d.deviceId).status = 'unbound';
  await nextGateway.sweep();
  assert.equal(fresh.closed(), true);
  await f.backend.sweep();
  assert.equal(f.store.commands.get(input.commandId).state, 'cancelled');
});

test('SIMULATED Mongo: immutable command, real signatures/encryption, durable receipt and result recovery', async () => {
  const f = await createFixture();
  const d = await newDevice();
  const live = await f.connect(
    d
  );
  const input = await f.prepare(
    live.peer
  );
  const sent = live.sent.find((m) => m.command === '__add_download__');
  const verified = await compactVerify(sent.payload.envelope, await importJWK(f.options.signing.publicKey, 'EdDSA'));
  const wrapper = JSON.parse(new TextDecoder().decode(verified.payload));
  const decrypted = await compactDecrypt(wrapper.jwe, d.encryption.privateKey);
  const protectedCommand = JSON.parse(new TextDecoder().decode(decrypted.plaintext));
  assert.equal(protectedCommand.commandId, input.commandId);
  assert.equal(protectedCommand.deviceVersion, 1);
  assert.equal(protectedCommand.sessionId, live.peer.session.sessionId);
  assert.match(protectedCommand.torrentUrl, /passkey=SECRET/);
  assert.equal(JSON.stringify(sent).includes('SECRET'), false);
  await f.coordinator.dispatch(input);
  assert.equal(f.urlCalls(), 1);
  await assert.rejects(f.coordinator.dispatch({ ...input, resourceId: 'other' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await f.grant(live.peer);
  const c = structuredClone(f.store.commands.get(input.commandId));
  await assert.rejects(
    f.gateway.message(
      live.peer,
      message('__command_result__', { commandId: input.commandId, executionId: 'execution-1', outcome: 'succeeded' })
    ),
    { code: 'TASK_EVIDENCE_REQUIRED' }
  );
  const result = message(
    '__command_result__',
    { commandId: input.commandId, executionId: 'execution-1', outcome: 'succeeded', evidence: f.evidence }
  );
  await f.gateway.message(live.peer, result);
  await f.gateway.message(live.peer, result);
  assert.equal(f.store.downloads.get(input.downloadId).association.executionId, 'execution-1');
  assert.deepEqual(f.store.downloads.get(input.downloadId).notificationTasks, ['preserve-notification']);
  const replacement = new RemoteDownloadService(f.backend.options);
  const recovery = await replacement.handle(
    '__recover_execution__',
    { context: live.peer.session, commandId: input.commandId, executionId: 'execution-1' }
  );
  assert.equal(recovery.mayExecute, false);
  assert.equal(recovery.result.outcome, 'succeeded');
  assert.equal(f.store.commands.get(input.commandId).grantExpiresAt, c.grantExpiresAt);
});

test('SIMULATED Mongo: lost results stay unknown, reconciliation never grants another add; duplicate has no association', async () => {
  const f = await createFixture();
  const d = await newDevice();
  const live = await f.connect(
    d
  );
  const input = await f.prepare(
    live.peer
  );
  await f.grant(
    live.peer
  );
  f.tick(31_000);
  await f.backend.sweep();
  assert.equal(f.store.commands.get(input.commandId).state, 'unknown');
  await f.gateway.message(
    live.peer,
    message('__request_execution__', { commandId: input.commandId, executionId: 'new-execution' })
  );
  assert.equal(live.sent.at(-1).command, '__execution_denied__');
  await f.gateway.message(
    live.peer,
    message('__command_result__', { commandId: input.commandId, executionId: 'execution-1', outcome: 'duplicate' })
  );
  assert.equal(f.store.downloads.get(input.downloadId).association, undefined);
  const query = await f.coordinator.query(input.commandId, 'owner-1');
  assert.equal(query.added, false);
});

test('SIMULATED Mongo: monotonic status, identity conflict, reconnect snapshot, unreachable distinct from deleted, platform close', async () => {
  const f = await createFixture();
  const d = await newDevice();
  const live = await f.connect(
    d
  );
  const input = await f.prepare(
    live.peer
  );
  await f.grant(
    live.peer
  );
  await f.gateway.message(
    live.peer,
    message(
      '__command_result__',
      { commandId: input.commandId, executionId: 'execution-1', outcome: 'succeeded', evidence: f.evidence }
    )
  );
  const payload = { commandId: input.commandId, executionId: 'execution-1', evidence: f.evidence, sequence: 2, state: 'downloading', progress: 0.5,
    downloadedBytes: 50, totalBytes: 100, downloadSpeed: 10, uploadSpeed: 0 };
  const update = message(
    '__download_status__', payload
  );
  await f.gateway.message(
    live.peer, update
  );
  await f.gateway.message(
    live.peer, update
  );
  await f.gateway.message(live.peer, message('__download_status__', { ...payload, sequence: 1, progress: 0.1 }));
  assert.equal(f.store.downloads.get(input.downloadId).status.sequence, 2);
  await assert.rejects(
    f.gateway.message(live.peer, message('__download_status__', { ...payload, progress: 0.6 })),
    { code: 'STATUS_SEQUENCE_CONFLICT' }
  );
  const fresh = await f.connect(d, f.gateway, false);
  await f.gateway.message(
    fresh.peer,
    message('__download_status__', { ...payload, sequence: 3, state: 'unreachable' })
  );
  assert.equal(f.store.downloads.get(input.downloadId).status.state, 'unreachable');
  await f.gateway.message(fresh.peer, message('__download_status__', { ...payload, sequence: 4, state: 'deleted' }));
  assert.equal(f.store.downloads.get(input.downloadId).status.state, 'deleted');
  await f.gateway.message(fresh.peer, message('__download_status__', { ...payload, sequence: 5, state: 'downloading' }));
  assert.equal(f.store.downloads.get(input.downloadId).status.state, 'deleted');
  await f.coordinator.close(input.commandId, 'owner-1', 'close-1');
  assert.equal(f.store.commands.get(input.commandId).state, 'closed');
  assert.equal(f.store.downloads.get(input.downloadId).result.outcome, 'succeeded');
  assert.equal(f.store.downloads.get(input.downloadId).association.executionId, 'execution-1');
  // Expired command history must not block a durable deletion receipt after a long offline period.
  f.store.commands.delete(input.commandId);
  await f.gateway.message(fresh.peer, message('__download_status__', { ...payload, sequence: 6, state: 'deleted' }));
  assert.equal(f.store.downloads.get(input.downloadId).status.sequence, 4);
});

test('SIMULATED Mongo: result retry repairs failed projection before ACK, without repeating URL or granting execution', async () => {
  const f = await createFixture();
  const live = await f.connect(
    await newDevice()
  );
  const input = await f.prepare(
    live.peer
  );
  await f.grant(
    live.peer
  );
  const project = f.store.projectResult.bind(f.store);
  let crash = true;
  f.store.projectResult = async (c) => {
    if (crash) {
      crash = false;
      throw new Error('SIMULATED_PROJECTION_FAILURE');
    }
    return project(c);
  };
  const result = message(
    '__command_result__',
    { commandId: input.commandId, executionId: 'execution-1', outcome: 'succeeded', evidence: f.evidence }
  );
  await assert.rejects(f.gateway.message(live.peer, result), /SIMULATED_PROJECTION_FAILURE/);
  assert.equal(live.sent.some((m) => m.command === '__command_result_ack__'), false);
  assert.equal(f.store.commands.get(input.commandId).result.outcome, 'succeeded');
  await f.gateway.message(live.peer, result);
  assert.equal(live.sent.at(-1).command, '__command_result_ack__');
  assert.equal(
    f.store.downloads.get(input.downloadId).association.executionId, 'execution-1'
  );
  assert.equal(
    f.urlCalls(),
    1
  );
});

test('SIMULATED Mongo: definite dispatch refusal cancels original add; uncertain timeout preserves identity', async () => {
  const { RpcError } = await import('../../packages/contract/dist/helper-gateway/socket-rpc.service.js');
  const { RemoteDownloadCoordinator } = await import('../../apps/api/src/modules/remote-downloads/remote-download-coordinator.service.ts');
  for (const effect of ['not_applied', 'unknown']) {
    const f = await createFixture();
    const live = await f.connect(await newDevice());
    const input = { commandId: 'dispatch-failure', downloadId: 'failure-download', ownerId: 'owner-1', deviceId: live.peer.session.deviceId,
      authVersion: 1, deviceVersion: 1, source: 'mteam', resourceId: 'release-1', correlationId: 'trace' };
    f.store.downloads.set(input.downloadId, { ...input, tmdbId: 1, executionMode: 'remote' });
    const coordinator = new RemoteDownloadCoordinator({ call: (c, p) => {
      return c === '__dispatch_download__' ? Promise.reject(new RpcError('RPC_TIMEOUT', effect)) : f.call(c, p);
    } }, f.backend);
    await assert.rejects(coordinator.dispatch(input), { code: 'RPC_TIMEOUT', effect });
    const command = f.store.commands.get(input.commandId);
    assert.equal(command.state, effect === 'not_applied' ? 'cancelled' : 'accepted');
    const deadline = command.expiresAt;
    const retried = await coordinator.dispatch(input);
    assert.equal(retried.expiresAt, deadline);
    if (effect === 'not_applied') {
      await f.gateway.pump(
        live.peer.session.deviceId
      );
      assert.equal(
        live.sent.some((m) => m.command === '__add_download__'),
        false
      );
    }
  }
});

test('SIMULATED Mongo: orphaned original intent is recovered with original deadline and expires without replay', async () => {
  const f = await createFixture();
  const live = await f.connect(
    await newDevice()
  );
  const input = await f.prepare(
    live.peer
  );
  const original = f.store.commands.get(input.commandId);
  f.store.commands.delete(input.commandId);
  f.tick(61_000);
  await f.backend.sweep();
  const recovered = f.store.commands.get(input.commandId);
  assert.equal(
    recovered.expiresAt, original.expiresAt
  );
  assert.equal(
    recovered.deliveryMessageId, original.deliveryMessageId
  );
  assert.equal(recovered.state, 'expired');
  assert.equal(f.urlCalls(), 1);
});

test('SIMULATED Mongo: concurrent identical requests retain one ciphertext, delivery identity and execution deadline', async () => {
  const f = await createFixture();
  const live = await f.connect(await newDevice());
  const input = { commandId: 'parallel', downloadId: 'parallel-download', ownerId: 'owner-1', deviceId: live.peer.session.deviceId,
    authVersion: 1, deviceVersion: 1, source: 'mteam', resourceId: 'release-1', correlationId: 'trace' };
  f.store.downloads.set(input.downloadId, { ...input, tmdbId: 1, executionMode: 'remote' });
  await Promise.all(Array.from({ length: 8 }, () => f.coordinator.dispatch(input)));
  const deliveries = live.sent.filter((m) => m.command === '__add_download__');
  assert.ok(deliveries.length > 0);
  assert.equal(new Set(deliveries.map((m) => m.messageId)).size, 1);
  assert.equal(new Set(deliveries.map((m) => m.payload.envelope)).size, 1);
});

test('SIMULATED Mongo: key rotation revokes current operations without events; existing grant becomes unknown, not cancelled', async () => {
  const f = await createFixture();
  const d = await newDevice();
  const live = await f.connect(
    d
  );
  const input = await f.prepare(
    live.peer
  );
  await f.grant(
    live.peer
  );
  f.store.accounts.get('owner-1').authVersion = 2;
  await assert.rejects(
    f.gateway.message(
      live.peer,
      message('__execution_recovery__', { commandId: input.commandId, executionId: 'execution-1' })
    ),
    { code: 'SESSION_REVOKED' }
  );
  await f.gateway.sweep();
  assert.equal(live.closed(), true);
  await f.backend.sweep();
  assert.equal(f.store.commands.get(input.commandId).result.outcome, 'unknown');
});

test('queue metadata is readable without a downloader, stays bound to the authenticated device and does not dispatch', async () => {
  const f = await createFixture();
  const live = await f.connect(await newDevice());
  live.peer.status = undefined;
  live.peer.statusObservedAt = undefined;
  const queried = [];
  f.store.queued = async (context) => {
    queried.push(context);
    return { observedAt: f.backend.now(), total: 1, nextCursor: null, items: [{ commandId: 'queued-command',
      resourceId: '991', source: 'mteam', title: 'Pending movie', enqueuedAt: f.backend.now() - 1,
      expiresAt: f.backend.now() + 60000, reason: 'downloader_unavailable' }] };
  };
  const request = message('__queue_request__', {});
  await f.gateway.message(live.peer, request);
  const result = live.sent.at(-1);
  assert.equal(result.command, '__queue_snapshot__');
  assert.equal(result.replyTo, request.messageId);
  assert.equal(result.payload.total, 1);
  assert.equal(queried[0].deviceId, live.peer.session.deviceId);
  assert.equal(f.store.commands.size, 0);
  await assert.rejects(f.gateway.message(live.peer, message('__queue_request__', { ownerId: 'other-owner' })), { code: 'INVALID_REQUEST' });
});
