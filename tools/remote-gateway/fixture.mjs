import { generateKeyPair, exportJWK, CompactSign } from '../../apps/helpers/gateway/node_modules/jose/dist/webapi/index.js';
import { GatewayService } from '../../apps/helpers/gateway/src/gateway.service.ts';
import { GatewayBridge } from '../../apps/helpers/gateway/src/infrastructure/gateway-bridge.service.ts';
import { MemoryCoordinator } from '../../apps/helpers/gateway/src/testing/memory-coordinator.fake.ts';
import { gatewayLogger } from '../../apps/helpers/gateway/src/gateway-logging.service.ts';
import { signingIdentity } from '../../apps/helpers/gateway/src/gateway-crypto.service.ts';
import { keyDigest, message } from '../../apps/helpers/gateway/src/gateway.domain.ts';
import { RemoteDownloadService } from '../../apps/api/src/modules/remote-downloads/remote-download.service.ts';
import { RemoteDownloadCoordinator } from '../../apps/api/src/modules/remote-downloads/remote-download-coordinator.service.ts';
import { MemoryControlStore } from '../../apps/api/src/modules/remote-downloads/testing/memory-control.store.ts';

export async function createFixture() {
  let now = Date.now();
  const store = new MemoryControlStore();
  const gatewayCoordinator = new MemoryCoordinator(() => now);
  store.accounts.set('owner-1', { ownerId: 'owner-1', keyDigest: keyDigest('fixture-api-key'), authVersion: 1, active: true });
  let urlCalls = 0;
  const backend = new RemoteDownloadService({ store, now: () => now, report() {},
    torrent: async () => {
      urlCalls++;
      return { url: 'https://tracker.invalid/download?passkey=SECRET', torrentHash: 'a'.repeat(40) };
    } });
  const signing = await generateKeyPair('EdDSA', { extractable: true });
  const options = { instanceId: 'gateway-1', gatewayCoordinator, signing: await signingIdentity('key-1', await exportJWK(signing.privateKey)),
    logger: gatewayLogger('silent'), verbose: false, now: () => now,
    popular: { call: async (command, payload) => backend.handle(command, payload) } };
  const gateway = new GatewayService(options);
  const call = async (command, payload, correlationId = 'correlation-1', messageId = crypto.randomUUID()) => {
    return gateway.handleRpc(command, payload,
      { protocolVersion: 1, command, payload, correlationId, messageId });
  };
  const coordinator = new RemoteDownloadCoordinator({ call }, backend);
  const bridge = new GatewayBridge();
  const connect = async (device, target = gateway, bind = true) => {
    const sent = [];
    let closed = false;
    const peer = { id: crypto.randomUUID(), digest: keyDigest(
      'fixture-api-key'
    ), send: (m) => {
      return sent.push(m);
    }, close: () => {
      closed = true;
    } };
    const start = () => {
      return target.message(peer, message('__authenticate__', { keys: device.keys, intent: bind ? 'bind' : 'authenticate',
        ...(bind ? { operationId: device.operationId } : { deviceId: device.deviceId }) }
      )
      );
    };
    const prove = async () => {
      const proof = await new CompactSign(new TextEncoder().encode(peer.challenge.text)).setProtectedHeader(
        { alg: 'EdDSA' }
      ).sign(
        device.signer.privateKey
      );
      await target.message(peer, message('__auth_proof__', { proof }));
      device.deviceId = peer.session.deviceId;
    };
    await start();
    await prove();
    await target.message(
      peer,
      message(
        '__agent_status__',
        { downloaderType: 'qbittorrent', instanceId: 'downloader-1', configured: true, reachable: true }
      )
    );
    return { peer, sent, closed: () => closed };
  };
  const prepare = async (peer, id = 'command-1') => {
    const input = { commandId: id, downloadId: 'download-' + id, ownerId: peer.session.ownerId, deviceId: peer.session.deviceId,
      authVersion: peer.session.authVersion, deviceVersion: peer.session.deviceVersion, source: 'mteam', resourceId: 'resource-1', correlationId: 'correlation-1' };
    store.downloads.set(
      input.downloadId,
      { ...input, tmdbId: 1, executionMode: 'remote', notificationTasks: ['preserve-notification'] }
    );
    await coordinator.dispatch(input);
    return input;
  };
  const grant = async (peer) => {
    await gateway.message(peer, message('__command_received__', { commandId: 'command-1' }));
    await gateway.message(
      peer,
      message('__request_execution__', { commandId: 'command-1', executionId: 'execution-1' })
    );
  };
  const evidence = { downloaderType: 'qbittorrent', instanceId: 'downloader-1', torrentHash: 'a'.repeat(40), taskId: 'task-1', marker: 'popular-execution-1' };
  return { store, gatewayCoordinator, backend, gateway, options, coordinator, call, connect, prepare, grant, evidence, bridge,
    tick: (ms) => { now += ms; }, urlCalls: () => urlCalls };
}
export async function newDevice() {
  const signer = await generateKeyPair('EdDSA', { extractable: true });
  const encryption = await generateKeyPair('RSA-OAEP-256', { extractable: true });
  return { signer, encryption, operationId: crypto.randomUUID(), keys: { signingKey: await exportJWK(signer.publicKey), encryptionKey: await exportJWK(encryption.publicKey) } };
}
export { message };
