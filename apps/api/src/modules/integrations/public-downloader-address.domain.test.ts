import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublicDownloaderAddress } from './public-downloader-address.domain.js';

test('direct downloader addresses accept public IPs and full domains only', () => {
  for (const value of [
    'https://8.8.8.8:8080', 'https://1.1.1.1', 'https://[2606:4700:4700::1111]',
    'https://downloads.example.com', 'https://xn--bcher-kva.example.com',
  ]) assert.equal(isPublicDownloaderAddress(new URL(value)), true, value);

  for (const value of [
    'http://localhost:8080', 'http://nas:8080', 'http://nas.local:8080', 'http://nas.example:8080',
    'http://127.0.0.1', 'http://0x7f000001', 'http://10.0.0.1', 'http://172.16.0.1',
    'http://192.168.1.1', 'http://169.254.1.1', 'http://100.64.0.1',
    'http://192.0.2.1', 'http://198.51.100.1', 'http://203.0.113.1',
    'http://[::1]', 'http://[fc00::1]', 'http://[fe80::1]', 'http://[::ffff:127.0.0.1]',
    'http://[2001:db8::1]', 'http://[2002:c0a8:101::]',
  ]) assert.equal(isPublicDownloaderAddress(new URL(value)), false, value);
});
