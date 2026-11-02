import assert from 'node:assert/strict';
import test from 'node:test';
import dns from 'node:dns';
import { createServer } from 'node:http';
import { QBittorrentClient } from '../qbittorrent/client.js';
import { TransmissionClient } from '../transmission/client.js';

test('both default downloader transports block a public hostname resolving to loopback before sending credentials', async (t) => {
  let received = 0;
  const server = createServer((_request, response) => {
    received++;
    response.end('v5.0');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.mock.method(dns, 'lookup', (_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    callback(null, ...(options.all ? [[{ address: '127.0.0.1', family: 4 }]] : ['127.0.0.1', 4]));
  });
  t.mock.method(dns.promises, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }]);
  const url = `http://downloader.attacker.com:${address.port}`;
  await assert.rejects(new QBittorrentClient(1000).verify(url, { authMethod: 'api_key', apiKey: 'test-key' }));
  await assert.rejects(new TransmissionClient(1000).verify(url, { username: 'test-user', password: 'test-password' }));
  assert.equal(received, 0);
});
