import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import tls from 'node:tls';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { createServer } from 'node:http';
import type { LookupAddress, LookupOptions } from 'node:dns';
import type { TcpNetConnectOpts } from 'node:net';
import { createPublicDownloaderLookup, PublicDownloaderHttpClient } from './public-downloader-http.client.js';
import { DownloaderAddressError } from './public-downloader-http.errors.js';
import type { DownloaderDnsResolver } from './public-downloader-http.types.js';
import { AiTrace, withAiTrace } from '../logging/ai-trace.js';

function lookup(resolve: DownloaderDnsResolver, options: LookupOptions = { all: true }): Promise<string | LookupAddress[]> {
  return new Promise((accept, reject) => {
    createPublicDownloaderLookup(resolve)('downloader.example.com', options, (error, address) => {
      if (error) reject(error);
      else accept(address);
    });
  });
}

test('socket lookup rejects non-public A/AAAA answers, mixed answers, invalid families and empty results', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '198.18.0.1', '192.0.2.1', '224.0.0.1', '240.0.0.1',
    '::1', '::', 'fc00::1', 'fe80::1', 'fec0::1', 'ff02::1', '::ffff:127.0.0.1',
    '::ffff:8.8.8.8', '64:ff9b::a00:1', '2002:7f00:1::', '2001:db8::1', '3fff::1']) {
    const family = net.isIP(address);
    await assert.rejects(lookup(async () => [{ address, family }]), DownloaderAddressError, address);
    await assert.rejects(lookup(async () => [{ address: '8.8.8.8', family: 4 }, { address, family }]), DownloaderAddressError, address);
  }
  await assert.rejects(lookup(async () => []), DownloaderAddressError);
  await assert.rejects(lookup(async () => [{ address: '8.8.8.8', family: 6 }]), DownloaderAddressError);
  await assert.rejects(lookup(async () => [{ address: 'not-an-ip', family: 4 }]), DownloaderAddressError);
});

test('socket lookup returns only the validated results and honors requested address families', async () => {
  const addresses = [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
  let resolutions = 0;
  const resolve = async () => {
    resolutions++;
    return addresses;
  };
  assert.deepEqual(await lookup(resolve), addresses);
  assert.equal(resolutions, 1);
  assert.equal(await lookup(resolve, { family: 4 }), '8.8.8.8');
  assert.deepEqual(await lookup(resolve, { family: 6, all: true }), [addresses[1]]);
  await assert.rejects(lookup(async () => [addresses[0]!], { family: 6 }), DownloaderAddressError);
  const cause = Object.assign(new Error('DNS unavailable'), { code: 'ENOTFOUND' });
  await assert.rejects(lookup(async () => {
    throw cause;
  }), (error) => error === cause);
});

test('direct IPs and unsupported URLs are blocked before transport or DNS, even when caller requests redirects', async (t) => {
  let resolutions = 0;
  const client = new PublicDownloaderHttpClient({ resolve: async () => {
    resolutions++;
    return [];
  } });
  t.after(() => client.close());
  for (const url of ['http://127.1', 'http://0x7f000001', 'http://2130706433', 'http://[::ffff:127.0.0.1]',
    'http://[2002:7f00:1::]', 'http://nas.local', 'http://nas', 'file:///etc/passwd',
    'http://user:password@8.8.8.8', 'http://8.8.8.8/#fragment']) {
    await assert.rejects(client.fetch(url, { redirect: 'follow' }), DownloaderAddressError, url);
  }
  assert.equal(resolutions, 0);
});

test('real HTTP uses the guarded lookup once, preserves Host, blocks redirects and rejects a rebound DNS answer', async (t) => {
  const requests: string[] = [];
  const hosts: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    hosts.push(request.headers.host);
    response.setHeader('connection', 'close');
    if (request.url === '/redirect') {
      response.writeHead(302, { location: `http://127.0.0.1:${port}/forbidden` });
    }
    response.end('public-downloader');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  let resolutions = 0;
  let rebound = false;
  const client = new PublicDownloaderHttpClient({ resolve: async () => {
    resolutions++;
    return [{ address: rebound ? '127.0.0.1' : '8.8.8.8', family: 4 }];
  } });
  t.after(() => client.close());
  const connect = net.connect;
  const validated: Array<string | LookupAddress[]> = [];
  // Only the test redirects an approved public socket to its local fixture.
  // Production retains the guarded lookup's public address unchanged.
  t.mock.method(net, 'connect', (options: TcpNetConnectOpts) => connect({
    ...options,
    lookup: (hostname, lookupOptions, callback) => options.lookup!(hostname, lookupOptions, (error, result) => {
      if (error) {
        callback(error, '');
        return;
      }
      validated.push(result);
      callback(null, lookupOptions.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4);
    }),
  }));
  const origin = `http://downloader.example.com:${port}`;
  assert.equal(await (await client.fetch(`${origin}/version`)).text(), 'public-downloader');
  assert.equal(resolutions, 1);
  assert.deepEqual(validated, [[{ address: '8.8.8.8', family: 4 }]]);
  assert.equal(hosts[0], `downloader.example.com:${port}`);
  await assert.rejects(client.fetch(`${origin}/redirect`, { redirect: 'follow' }));
  assert.deepEqual(requests, ['/version', '/redirect']);
  rebound = true;
  await assert.rejects(client.fetch(`${origin}/rebound`));
  assert.equal(resolutions, 3);
  assert.equal(validated.length, 2);
  assert.deepEqual(requests, ['/version', '/redirect']);
});

test('HTTPS retains the original TLS hostname, guarded lookup and normal certificate verification', async (t) => {
  let options: tls.ConnectionOptions | undefined;
  t.mock.method(tls, 'connect', (input: tls.ConnectionOptions) => {
    options = input;
    throw new Error('Stop before external TLS connection');
  });
  const client = new PublicDownloaderHttpClient();
  t.after(() => client.close());
  await assert.rejects(client.fetch('https://downloader.example.com:8443/version'));
  assert.equal(options?.host, 'downloader.example.com');
  assert.equal(options?.servername, 'downloader.example.com');
  assert.notEqual(options?.rejectUnauthorized, false);
  assert.equal(typeof options?.lookup, 'function');
});

test('global or caller dispatchers cannot bypass destination validation through a proxy', async (t) => {
  const previous = getGlobalDispatcher();
  const proxy = new MockAgent();
  proxy.disableNetConnect();
  proxy.get('http://downloader.example.com').intercept({ path: '/' }).reply(200, 'unsafe-proxy-response').persist();
  setGlobalDispatcher(proxy);
  t.after(async () => {
    setGlobalDispatcher(previous);
    await proxy.close();
  });
  const client = new PublicDownloaderHttpClient({ resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
  t.after(() => client.close());
  await assert.rejects(client.fetch('http://downloader.example.com'));
  await assert.rejects(client.fetch('http://downloader.example.com', {
    dispatcher: proxy as unknown as NonNullable<RequestInit['dispatcher']>,
  }));
});

test('diagnostics retain the correlation and DNS failure stage without logging headers or payloads', async (t) => {
  for (const verbose of [false, true]) {
    const errors: unknown[] = [];
    const events: unknown[] = [];
    const client = new PublicDownloaderHttpClient({ verbose, logger: {
      info: (fields: unknown) => events.push(fields), error: (fields: unknown) => errors.push(fields),
    }, resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    t.after(() => client.close());
    await withAiTrace(new AiTrace(undefined, { correlationId: 'ssrf-correlation' }, ''), async () => {
      await assert.rejects(client.fetch('http://downloader.example.com', {
        method: 'POST', headers: { authorization: 'Bearer private-key' }, body: 'private-payload',
      }));
    });
    assert.equal(events.length > 0, verbose);
    const logged = JSON.stringify(errors);
    assert.match(logged, /ssrf-correlation/);
    assert.match(logged, /downloader.dns.resolve/);
    assert.match(logged, /DOWNLOADER_ADDRESS_BLOCKED/);
    assert.ok(!logged.includes('private-key') && !logged.includes('private-payload'));
  }
});
