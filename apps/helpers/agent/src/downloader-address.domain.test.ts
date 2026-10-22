import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultPort, downloaderAddressUrl, parseDownloaderAddress } from './downloader-address.domain';

test('host-only input uses downloader defaults and protocol selection', () => {
  assert.equal(defaultPort('transmission'), '9091');
  assert.equal(defaultPort('qbittorrent'), '8080');
  assert.equal(downloaderAddressUrl({ protocol: 'https', host: '127.0.0.1', port: '' }, 'transmission'), 'https://127.0.0.1:9091');
  assert.deepEqual(parseDownloaderAddress('127.0.0.1', 'transmission'), { protocol: 'http', host: '127.0.0.1', port: '9091' });
});

test('complete URLs preserve custom routes, ports and IPv6 across editing', () => {
  for (const raw of ['https://localhost:443/custom/rpc', 'http://[::1]:9091/custom/rpc', 'http://127.0.0.1:1234/custom/rpc']) {
    const address = parseDownloaderAddress(raw, 'transmission');
    assert.equal(downloaderAddressUrl(address, 'transmission'), raw);
    assert.equal(downloaderAddressUrl({ protocol: 'http', host: raw, port: '8080' }, 'transmission'), raw);
  }
  const root = parseDownloaderAddress('http://127.0.0.1:9091/', 'transmission');
  assert.deepEqual(root, parseDownloaderAddress('http://127.0.0.1:9091/transmission/rpc', 'transmission'));
  assert.equal(downloaderAddressUrl({ ...root, host: 'localhost:1234' }, 'transmission'), 'http://localhost:1234');
});

test('pasted secrets and unsupported protocols cannot be silently discarded', () => {
  for (const raw of ['http://user:pass@localhost', 'http://localhost/?key=secret', 'http://localhost/#secret', 'ftp://localhost']) {
    assert.throws(() => parseDownloaderAddress(raw, 'transmission'));
  }
});

test('LAN IPs and hostnames retain the selected protocol, default ports and custom paths', () => {
  for (const [raw, host, port] of [
    ['192.168.1.5', '192.168.1.5', '9091'],
    ['10.0.0.20:1234', '10.0.0.20', '1234'],
    ['172.16.0.10', '172.16.0.10', '9091'],
    ['nas.local', 'nas.local', '9091'],
    ['https://nas.home:443/custom/rpc', 'nas.home/custom/rpc', '443'],
    ['[fd00::5]', '[fd00::5]', '9091'],
  ]) {
    const address = parseDownloaderAddress(raw!, 'transmission');
    assert.equal(address.host, host);
    assert.equal(address.port, port);
    const roundtrip = parseDownloaderAddress(downloaderAddressUrl(address, 'transmission'), 'transmission');
    assert.deepEqual(roundtrip, address);
  }
  assert.equal(downloaderAddressUrl({ protocol: 'https', host: 'nas.local', port: '' }, 'qbittorrent'), 'https://nas.local:8080');
});
