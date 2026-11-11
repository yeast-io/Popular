import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPair, exportJWK } from 'jose';
import { AgentResourceRelay } from './agent-resource-relay.service.js';
import { signingIdentity } from './gateway-crypto.service.js';
import { message } from './gateway.domain.js';
import type { Peer } from './gateway.types.js';
import type { WireMessage } from '@movie-hub/contract';

async function fixture() {
  const keys = await generateKeyPair('EdDSA', { extractable: true });
  const signing = await signingIdentity('key-1', await exportJWK(keys.privateKey));
  const sent: WireMessage[] = [];
  const peer: Peer = {
    id: 'peer-1',
    digest: 'digest',
    session: {
      ownerId: 'owner-1',
      deviceId: 'device-1',
      authVersion: 1,
      deviceVersion: 1,
      sessionId: 'session-1',
      instanceId: 'gateway-1',
    },
    status: { downloaderType: 'qbittorrent', instanceId: 'downloader-1', configured: false, reachable: false, resourceProtocol: 1 },
    send: (wire) => {
      sent.push(wire);
    },
    close() {},
  };
  const relay = new AgentResourceRelay();
  const request = () => relay.request(peer, signing, { operation: 'list' }, 'trace-1', Date.now() + 1000);
  const ready = async () => {
    while (!sent.length) await new Promise((resolve) => setImmediate(resolve));
  };
  const reply = (result: unknown) => ({
    ...message('__resource_response__', { ok: true, result }),
    replyTo: sent[0]!.messageId,
    correlationId: 'trace-1',
  });
  return { relay, peer, sent, request, ready, reply, signing };
}
test('relay binds signed requests and ignores other owners or session responses', async () => {
  const f = await fixture();
  const pending = f.request();
  await f.ready();
  const token = (f.sent[0]!.payload as { request: string }).request;
  const body = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
  assert.equal(body.ownerId, 'owner-1');
  assert.equal(body.command, '__resource_request__');
  assert.equal(body.correlationId, 'trace-1');
  f.relay.accept({ ...f.peer, session: { ...f.peer.session!, ownerId: 'other' } }, f.reply([]));
  f.relay.accept(f.peer, { ...f.reply([]), correlationId: 'other' });
  f.relay.accept(f.peer, f.reply([]));
  assert.deepEqual(await pending, []);
});
test('relay rejects secrets or download URLs in public payloads', async () => {
  const f = await fixture();
  const pending = f.request();
  await f.ready();
  f.relay.accept(
    f.peer,
    f.reply([
      { site: 'mteam', enabled: true, status: 'configured_valid', version: '', verifiedAt: null, apiKey: 'secret' },
    ])
  );
  await assert.rejects(pending, { code: 'AGENT_RESOURCE_INVALID_RESPONSE' });
});
test('disconnect rejects outstanding requests; old agents cannot receive requests', async () => {
  const f = await fixture();
  const pending = f.request();
  await f.ready();
  f.relay.dropped(f.peer);
  await assert.rejects(pending, { code: 'DEVICE_OFFLINE' });
  delete f.peer.status!.resourceProtocol;
  await assert.rejects(f.request(), { code: 'AGENT_RESOURCE_UNSUPPORTED' });
});
test('expired and silent requests time out instead of leaving pending work', async () => {
  const f = await fixture();
  await assert.rejects(f.relay.request(f.peer, f.signing, { operation: 'list' }, 'trace-1', Date.now() - 1), {
    code: 'AGENT_RESOURCE_TIMEOUT',
  });
  const pending = f.relay.request(f.peer, f.signing, { operation: 'list' }, 'trace-1', Date.now() + 25);
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(pending, { code: 'AGENT_RESOURCE_TIMEOUT' });
  } finally {
    clearTimeout(keepAlive);
  }
});
