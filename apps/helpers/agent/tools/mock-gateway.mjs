// Integration fixture: REAL GatewayService/routes/crypto + Popular domain service.
// SIMULATED account persistence, routing store and local downloaders. No .env or external services.
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createFixture } from '../../../../tools/remote-gateway/fixture.mjs';
import { createGatewayApp } from '../../gateway/src/gateway.routes.ts';
import { seal } from '../../gateway/src/gateway-crypto.service.ts';
import { message } from '../../gateway/src/gateway.domain.ts';

export async function startMock({ port = 0 } = {}) {
  const f = await createFixture();
  f.gateway.now = Date.now;
  f.backend.now = Date.now;
  f.router.now = Date.now;
  const stats = { binds: 0, auth: 0, adds: 0, grants: 0, duplicateEvents: 0, recoveries: 0, errors: [] };
  const received = [];
  const events = new Map();
  const deliveries = new Map();
  const tasks = new Map();
  let phase = 'downloading';
  let dropAck = false;
  let dropAckState = null;
  let dropAdd = false;
  let offline = false;
  let neverCreate = false;
  let modern = false;
  let corrupt = null;
  let dropGrant = false;
  let dropAuthResult = false;
  let slowAdd = false;
  let hash = 'a'.repeat(40);
  const original = f.gateway.message.bind(f.gateway);
  f.gateway.message = async (peer, wire) => {
    if (!peer.wrapped) {
      peer.wrapped = true;
      const send = peer.send.bind(peer);
      peer.send = (reply) => {
        if (reply.command === '__auth_result__') {
          stats.auth++;
          if (dropAuthResult) {
            dropAuthResult = false;
            peer.close(1012);
            return;
          }
        }
        if (reply.command === '__execution_granted__') {
          stats.grants++;
          if (dropGrant) {
            dropGrant = false;
            peer.close(1012);
            return;
          }
          if (corrupt === 'grant') {
            reply = { ...reply, payload: { grant: reply.payload.grant.slice(0, -4) + 'AAAA' } };
            corrupt = null;
          }
        }
        if (
          reply.command.endsWith('_ack__')
          && (dropAck || (dropAckState && events.get(reply.replyTo)?.payload?.state === dropAckState))
        ) {
          dropAck = false;
          dropAckState = null;
          return;
        }
        send(reply);
      };
    }
    if (['__command_result__', '__download_status__'].includes(wire.command)) {
      received.push(structuredClone(wire));
      if (events.has(wire.messageId)) stats.duplicateEvents++;
      else events.set(wire.messageId, structuredClone(wire));
    }
    if (wire.command === '__execution_recovery__') stats.recoveries++;
    try {
      return await original(peer, wire);
    } catch (error) {
      stats.errors.push(error.code ?? 'INTERNAL_ERROR');
      throw error;
    }
  };
  const bind = f.store.bind.bind(f.store);
  f.store.bind = async (...args) => {
    const before = f.store.devices.size;
    const result = await bind(...args);
    stats.binds += f.store.devices.size - before;
    return result;
  };
  f.backend.options.torrent = async () => ({
    url: `https://tracker.invalid/download?hash=${hash}&passkey=DO_NOT_LOG`,
    torrentHash: hash,
  });
  const app = await createGatewayApp(f.gateway, 'internal-test-token-0000000000000000', { allowInsecureDev: true });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) =>
    done(null, body)
  );
  const json = (_request, reply, body) => reply.send(body);
  app.get('/test/stats', async () => ({
    ...stats,
    events: [...events.values()],
    received,
    tasks: [...tasks.values()],
    clients: f.gateway.peers.size,
    devices: [...f.store.devices.values()].map((d) => ({ deviceId: d.deviceId, status: d.status })),
    statuses: [...f.gateway.peers.values()].map((p) => p.status),
    commands: [...f.store.commands.values()].map((c) => ({
      commandId: c.commandId,
      executionId: c.executionId,
      state: c.state,
      result: c.result,
    })),
  }));
  app.post('/test/control', async (request) => {
    const body = request.body;
    if ('phase' in body) phase = body.phase;
    if ('modern' in body) modern = body.modern;
    if ('dropAdd' in body) dropAdd = body.dropAdd;
    if ('dropAck' in body) dropAck = body.dropAck;
    if ('dropAckState' in body) dropAckState = body.dropAckState;
    if ('offline' in body) offline = body.offline;
    if ('neverCreate' in body) neverCreate = body.neverCreate;
    if ('dropGrant' in body) dropGrant = body.dropGrant;
    if ('dropAuthResult' in body) dropAuthResult = body.dropAuthResult;
    if ('slowAdd' in body) slowAdd = body.slowAdd;
    if ('corrupt' in body) corrupt = body.corrupt;
    if (body.clearTasks) tasks.clear();
    if (body.manual) tasks.set(body.manual, { id: tasks.size + 1, hash: body.manual, tags: '', labels: [] });
    if (body.revoke) {
      f.store.accounts.get('owner-1').active = false;
      for (const peer of f.gateway.peers.values()) {
        peer.send(message('__session_revoked__', { code: 'SESSION_REVOKED' }));
        peer.close(4001);
      }
    }
    if (body.unbind) {
      for (const device of f.store.devices.values()) device.status = 'unbound';
      for (const peer of f.gateway.peers.values()) {
        peer.send(message('__session_revoked__', { code: 'SESSION_REVOKED' }));
        peer.close(4001);
      }
    }
    if (body.disconnect) for (const peer of f.gateway.peers.values()) peer.close(1012);
    if (body.issue) {
      const peer = [...f.gateway.peers.values()][0];
      if (!peer?.session) throw Error('fixture has no authenticated client');
      hash = body.hash ?? 'a'.repeat(40);
      const id = body.commandId ?? randomUUID();
      if (deliveries.has(id)) {
        peer.send(deliveries.get(id));
      } else {
        const input = {
          commandId: id,
          downloadId: body.downloadId ?? randomUUID(),
          ownerId: peer.session.ownerId,
          deviceId: peer.session.deviceId,
          authVersion: peer.session.authVersion,
          deviceVersion: peer.session.deviceVersion,
          source: 'mteam',
          resourceId: 'resource-1',
          correlationId: 'trace-' + id,
        };
        f.store.downloads.set(input.downloadId, {
          ...input,
          downloaderType: peer.status?.downloaderType,
          tmdbId: 1,
          executionMode: 'remote',
        });
        const send = peer.send;
        const invalid = body.expired || body.wrongSession || body.wrongOwner || body.wrongHash || body.tampered;
        peer.send = (wire) => {
          if (wire.command === '__add_download__') {
            deliveries.set(id, structuredClone(wire));
            if (invalid) return;
          }
          send(wire);
        };
        await f.coordinator.dispatch(input);
        peer.send = send;
        if (body.expired || body.wrongSession || body.wrongOwner || body.wrongHash || body.tampered) {
          // A separate delivery with a genuine server signature exercises protected-field validation.
          const command = f.store.commands.get(id);
          const protectedPayload = {
            protocolVersion: 1,
            command: '__add_download__',
            messageId: command.deliveryMessageId,
            ...input,
            sessionId: body.wrongSession ? 'other-session' : peer.session.sessionId,
            ownerId: body.wrongOwner ? 'other-owner' : input.ownerId,
            expiresAt: body.expired ? Date.now() - 1 : Date.now() + 60000,
            torrentUrl: `https://tracker.invalid/download?hash=${hash}&passkey=DO_NOT_LOG`,
            torrentHash: body.wrongHash ? 'z'.repeat(40) : hash,
          };
          let envelope = await seal(f.options.signing, f.store.devices.get(input.deviceId).keys, protectedPayload);
          if (body.tampered) envelope = envelope.slice(0, -4) + 'AAAA';
          // The normal delivery was withheld: only this invalid variant reaches the client.
          peer.send({ ...deliveries.get(id), payload: { envelope } });
        }
      }
    }
    return { ok: true };
  });
  app.all('/qb/*', async (request, reply) => {
    if (offline) return reply.code(503).send({});
    const path = request.url.split('?')[0];
    if (path.endsWith('/auth/login')) return reply.header('Set-Cookie', 'SID=mock').send('Ok.');
    if (path.endsWith('/app/version')) return reply.send('v5.0.0');
    if (path.endsWith('/torrents/info')) {
      const hashes = new URL(request.url, 'http://localhost').searchParams.get('hashes')?.split('|');
      return [...tasks.values()]
        .filter((t) => !hashes || hashes.includes(t.hash))
        .map((t) => ({
          ...t,
          state: phase === 'paused' ? 'pausedDL' : phase === 'failed' ? 'error' : 'downloading',
          progress: phase === 'completed' ? 1 : 0.5,
          dlspeed: 100,
          upspeed: 10,
          total_size: 1000,
          downloaded: 500,
          uploaded: 10,
        }));
    }
    if (path.endsWith('/torrents/add')) {
      stats.adds++;
      const form = new URLSearchParams(request.body);
      if ([...form.keys()].sort().join(',') !== 'tags,urls') throw Error('unexpected add fields');
      const hash = new URL(form.get('urls')).searchParams.get('hash');
      if (!tasks.has(hash) && !neverCreate)
        tasks.set(hash, {
          id: tasks.size + 1,
          hash: hash.length === 64 ? hash.slice(0, 40) : hash,
          ...(hash.length === 64 ? { infohash_v2: hash } : {}),
          tags: form.get('tags'),
          labels: [],
        });
      if (slowAdd) await new Promise((resolve) => setTimeout(resolve, 5000));
      if (dropAdd) {
        dropAdd = false;
        reply.raw.destroy();
        return reply;
      }
      return reply.send('Ok.');
    }
    return reply.code(404).send({});
  });
  app.post('/transmission/rpc', async (request, reply) => {
    if (offline) return reply.code(503).send({});
    if (request.headers['x-transmission-session-id'] !== 'mock-session') {
      reply.header('X-Transmission-Session-Id', 'mock-session');
      if (modern) reply.header('X-Transmission-Rpc-Version', '6.0.0');
      return reply.code(409).send('');
    }
    const body = request.body;
    const method = body.method.replaceAll('_', '-');
    const input = body.arguments ?? body.params;
    let args;
    if (method === 'session-get') args = { version: '4.1.0' };
    else if (method === 'torrent-get')
      args = {
        torrents: [...tasks.values()]
          .filter((t) => input.ids.includes(t.hash))
          .map((t) => ({
            ...t,
            hashString: t.hash,
            status: phase === 'paused' ? 0 : 4,
            percentDone: phase === 'completed' ? 1 : 0.5,
            rateDownload: 100,
            rateUpload: 10,
            totalSize: 1000,
            downloadedEver: 500,
            uploadedEver: 10,
            error: phase === 'failed' ? 1 : 0,
          })),
      };
    else if (method === 'torrent-add') {
      stats.adds++;
      if (Object.keys(input).sort().join(',') !== 'filename,labels') throw Error('unexpected add fields');
      const hash = new URL(input.filename).searchParams.get('hash');
      const existing = tasks.has(hash);
      if (!existing && !neverCreate) tasks.set(hash, { id: tasks.size + 1, hash, tags: '', labels: input.labels });
      args = { [existing ? 'torrent-duplicate' : 'torrent-added']: { hashString: hash, id: tasks.get(hash)?.id ?? 1 } };
      if (slowAdd) await new Promise((resolve) => setTimeout(resolve, 5000));
      if (dropAdd) {
        dropAdd = false;
        reply.raw.destroy();
        return reply;
      }
    } else throw Error('unexpected method');
    if (body.jsonrpc) {
      const snake = (value) =>
        Array.isArray(value)
          ? value.map(snake)
          : value && typeof value === 'object'
            ? Object.fromEntries(
                Object.entries(value).map(([k, v]) => [
                  k.replaceAll('-', '_').replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
                  snake(v),
                ])
              )
            : value;
      return json(request, reply, { jsonrpc: '2.0', id: 1, result: snake(args) });
    }
    return json(request, reply, { result: 'success', tag: 1, arguments: args });
  });
  const address = await app.listen({ host: '127.0.0.1', port });
  return { url: address, close: () => app.close() };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = await startMock({ port: Number(process.env.MOCK_PORT ?? 0) });
  process.stdout.write(`${mock.url}\n`);
  process.on('SIGTERM', () => {
    void mock.close();
  });
  process.on('SIGINT', () => {
    void mock.close();
  });
}
