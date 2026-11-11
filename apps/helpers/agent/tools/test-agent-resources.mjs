// Local integration: real Web server/Core/Gateway protocol; simulated account store/downloaders.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { AgentResourceService } from '../../../api/src/modules/agent-resources/agent-resource.service.ts';
import { AgentResourceSource } from '../../../api/src/modules/agent-resources/agent-resource-source.adapter.ts';
import { RemoteTorrentService } from '../../../api/src/modules/remote-downloads/remote-torrent.service.ts';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-gateway.mjs';

for (const name of Object.keys(process.env)) if (name.startsWith('HELPER_REAL_')) delete process.env[name];
const root = fileURLToPath(new URL('../../../..', import.meta.url));
const binary = resolve(root, 'apps/helpers/agent/target/debug/popular-agent-web');
const password = 'synthetic-web-integration-password';
async function waitFor(test, label) {
  for (let i = 0; i < 120; i++) {
    const value = await test();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw Error(`Timed out: ${label}`);
}
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}
for (const provider of ['qbittorrent']) {
  const directory = await mkdtemp(join(tmpdir(), 'popular-web-integration-'));
  const secrets = join(directory, 'secrets');
  const mock = await startMock();
  const key = 'synthetic-resource-key';
  const siteCookie = 'uid=8811; session=synthetic-resource-cookie';
  const passkey = 'synthetic-resource-passkey';
  const info = 'd6:lengthi1e4:name1:a6:pieces0:e';
  const torrentHash = createHash('sha1').update(info).digest('hex');
  let expired = false;
  let preparations = 0;
  const identity
    = "<a href='usercp.php'>profile</a><div id='info_block'><a href='userdetails.php?id=8811'>me</a></div><div id='site_header'><div class='userinfo'><a href='userdetails.php?id=8811'>me</a></div></div>";
  const observed = [];
  const sites = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    observed.push({ path: url.pathname, key: request.headers['x-api-key'], cookie: request.headers.cookie });
    if (expired) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      assert.equal(request.headers['x-api-key'], key);
      response.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/member/profile') response.end(JSON.stringify({ code: '0', data: { id: '8811' } }));
      else if (url.pathname === '/api/torrent/search')
        response.end(
          JSON.stringify({
            code: '0',
            data: {
              data: [
                {
                  id: '123',
                  name: 'Synthetic.Movie.2026.1080p.BluRay',
                  size: '1073741824',
                  status: { visible: 1, banned: 0, seeders: 0 },
                },
                { id: '124', name: 'Unknown.Seeders.2026', status: { visible: 1, banned: 0 } },
              ],
              total: 2,
            },
          })
        );
      else if (url.pathname === '/api/torrent/genDlToken') {
        preparations++;
        response.end(
          JSON.stringify({
            code: '0',
            data: `${siteBase}download.php?hash=${torrentHash}&privateToken=synthetic-private-token`,
          })
        );
      } else {
        response.writeHead(404);
        response.end();
      }
    } else if (url.pathname === '/download.php') {
      assert.equal(request.headers['x-api-key'], undefined);
      assert.equal(request.headers.cookie, undefined);
      response.end(`d4:info${info}e`);
    } else {
      assert.equal(request.headers.cookie, siteCookie);
      const hdwing = `<table class='torrent_list'><tr><td class='t_name'><h3><a href='details.php?id=123'>Synthetic.Movie.2026</a></h3></td><td class='t_size'>1 GB</td><td class='t_torrents'>3</td></tr></table>`;
      const hdarea = `<table class='torrents'><tr><td><table class='torrentname'><tr><td><a href='details.php?id=123'>Synthetic.Movie.2026</a><br>第10-16集</td></tr></table></td><td>1 GB</td><td>0</td><td>0</td><td>0</td><td>1</td></tr></table>`;
      const token = Buffer.from('1\n123\n8811').toString('base64url') + '.synthetic-signature';
      response.end(
        identity
        + (url.pathname === '/torrents.php'
          ? hdwing + hdarea
          : url.pathname === '/details.php'
            ? `<h1>Synthetic.Movie.2026</h1><div id='site_content'><h2>Synthetic.Movie.2026</h2><a href='download.php?uid=8811&amp;hash=${token}'>download</a></div>`
            : '')
      );
    }
  });
  sites.listen(0, '127.0.0.1');
  await once(sites, 'listening');
  const siteBase = `http://127.0.0.1:${sites.address().port}/`;
  let preferences = { defaults: { resource: 'hdwing' }, selectedSites: ['hdwing'] };
  const f = mock.fixture;
  const resources = new AgentResourceService({
    preferences: {
      read: async () => preferences,
      setResourceAgent: async (_owner, device, selected) => {
        const { resourceAgentDeviceId, ...rest } = preferences;
        preferences = {
          ...rest,
          resourceExecutionId: crypto.randomUUID(),
          ...(device
            ? { resourceAgentDeviceId: device, agentSelectedSites: selected, agentDefaultSite: selected[0] }
            : {}),
        };
      },
    },
    authorization: {
      account: async (owner) => ({ key: f.store.accounts.get(owner) }),
      device: async (owner, device) => {
        const row = f.store.devices.get(device);
        return row?.ownerId === owner ? row : null;
      },
    },
    gateway: { call: f.call },
  });
  let cloudCalls = 0;
  const source = new AgentResourceSource(
    {
      id: 'mteam',
      name: 'M-Team',
      details: false,
      status: async () => 'configured_valid',
      search: async () => {
        cloudCalls++;
        return { releases: [] };
      },
    },
    resources
  );
  const resolver = new RemoteTorrentService(
    {
      resolveRemote: async () => {
        throw Error('cloud credential fallback');
      },
    },
    async () => {
      throw Error('cloud torrent read');
    }
  );
  resolver.agentResources = resources;
  f.backend.options.torrent = (command, download) => resolver.resolve(command, download);

  let child;
  let cookie = '';
  let csrf = '';
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    AGENT_WEB_BIND: `127.0.0.1:${port}`,
    AGENT_WEB_ORIGIN: base,
    AGENT_DATA_DIR: join(directory, 'data'),
    AGENT_WEB_STATIC_DIR: resolve(root, 'apps/helpers/agent/web/dist'),
    AGENT_MASTER_KEY_FILE: join(secrets, 'master.key'),
    AGENT_ADMIN_PASSWORD_FILE: join(secrets, 'admin-password'),
    HELPER_ALLOW_INSECURE_DEV: 'true',
    VERBOSE: 'false',
    LOG_LEVEL: 'off',
  };
  const start = async () => {
    child = spawn(binary, [], { cwd: directory, env, stdio: 'ignore' });
    await waitFor(async () => {
      if (child.exitCode !== null) throw Error('Web server exited before readiness');
      return fetch(`${base}/health/ready`)
        .then((r) => r.ok)
        .catch(() => false);
    }, 'Web ready');
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0);
    child = undefined;
  };
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        origin: base,
        cookie,
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return value;
  };
  const login = async () => {
    csrf = (await api('/session', 'POST', { password })).csrf;
  };
  const stats = () => fetch(`${mock.url}/test/stats`).then((r) => r.json());
  try {
    assert.equal(spawnSync(binary, ['--init-secrets', secrets], { env, stdio: 'ignore' }).status, 0);
    await writeFile(join(secrets, 'admin-password'), password);
    await start();
    await login();
    await api('/gateway/connect', 'POST', {
      gatewayUrl: mock.url,
      locale: 'zh-CN',
      apiKey: { action: 'set', value: 'fixture-api-key' },
    });
    const downloaderUrl = provider === 'qbittorrent' ? `${mock.url}/qb` : `${mock.url}/transmission/rpc`;
    await api('/downloader/test', 'POST', {
      provider,
      downloaderUrl,
      username: 'fixture-user',
      authMode: 'password',
      password: { action: 'set', value: 'fixture-downloader-secret' },
    });
    await waitFor(async () => (await api('/runtime')).service === 'online', 'Gateway online');
    const before = (await api('/runtime')).deviceId;
    assert.ok(before);
    await waitFor(
      async () => (await stats()).statusReports.some((s) => s.configured && s.reachable),
      'downloader status'
    );
    for (const site of ['mteam', 'hdarea', 'hdwing'])
      await api('/resource-sites/configure', 'POST', {
        site,
        baseUrl: siteBase,
        credential: { action: 'set', value: site === 'mteam' ? key : siteCookie },
        passkey: site === 'hdarea' ? { action: 'set', value: passkey } : { action: 'keep' },
      });
    await resources.setMode('owner-1', before);
    const metadata = await resources.states('owner-1');
    assert.equal(metadata.length, 3);
    const found = await source.search('owner-1', { query: 'Synthetic' }, new AbortController().signal);
    assert.equal(found.releases.length, 2);
    assert.equal(found.releases[0].seeders, 0);
    assert.equal(found.releases[1].seeders, undefined);
    for (const site of ['hdarea', 'hdwing']) {
      const result = await resources.search('owner-1', site, { query: 'Synthetic' }, new AbortController().signal);
      assert.equal(result.releases[0].id, '123');
      if (site === 'hdarea') assert.match(result.releases[0].description, /第10-16集/);
      assert.equal((await resources.detail('owner-1', site, '123', new AbortController().signal)).id, '123');
      const version = metadata.find((row) => row.site === site).version;
      const ticket = await resources.prepare('owner-1', site, '123', crypto.randomUUID(), before, version);
      assert.equal(ticket.torrentHash, torrentHash);
      assert.equal(ticket.url, undefined);
    }
    const version = metadata.find((row) => row.site === 'mteam').version;
    const commandId = crypto.randomUUID();
    const ticket = await resources.prepare('owner-1', 'mteam', '123', commandId, before, version);
    assert.deepEqual(await resources.prepare('owner-1', 'mteam', '123', commandId, before, version), ticket);
    assert.equal(preparations, 1);
    assert.equal(cloudCalls, 0);
    await assert.rejects(resources.execute('other-owner', { operation: 'list' }, before));
    await fetch(`${mock.url}/test/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        issue: true,
        hash: torrentHash,
        commandId,
        resourceId: '123',
        resourceExecution: 'agent',
        resourceCredentialVersion: version,
      }),
    });
    await waitFor(
      async () => (await stats()).commands.some((c) => c.state === 'succeeded'),
      'local ticket download succeeded'
    ).catch(async (error) => {
      const state = await stats();
      console.error(
        JSON.stringify({
          commands: state.commands,
          errors: state.errors,
          events: state.received.filter((w) => w.command === '__command_result__'),
          grants: state.grants,
          adds: state.adds,
        })
      );
      throw error;
    });
    assert.equal((await stats()).adds, 1);
    assert.equal(preparations, 1);
    const wireText = JSON.stringify((await stats()).received);
    for (const secret of [key, siteCookie, passkey, 'synthetic-private-token', siteBase])
      assert.ok(!wireText.includes(secret), `cloud wire leaked ${secret}`);
    expired = true;
    await assert.rejects(source.search('owner-1', { query: 'Synthetic' }, new AbortController().signal), {
      reason: 'authentication',
    });
    assert.equal((await api('/resource-sites')).find((row) => row.site === 'mteam').status, 'configured_invalid');
    expired = false;
    const settings = await api('/settings');
    assert.equal(settings.hasApiKey, true);
    assert.equal(settings.hasPassword, true);
    const publicText = JSON.stringify(settings);
    assert.ok(!publicText.includes('fixture-api-key'));
    assert.ok(!publicText.includes('fixture-downloader-secret'));
    const credentials = join(directory, 'data/credentials');
    for (const name of await readdir(credentials)) {
      const text = await readFile(join(credentials, name), 'utf8');
      assert.ok(!text.includes('fixture-api-key'));
      assert.ok(!text.includes('fixture-downloader-secret'));
      assert.ok(!text.includes('privateKey'));
    }
    await stop();
    await start();
    assert.equal((await api('/session')).authenticated, false);
    await login();
    await waitFor(async () => (await api('/runtime')).service === 'online', 'restart reconnect');
    assert.equal((await api('/runtime')).deviceId, before);
    assert.equal((await stats()).binds, 1);
    assert.equal((await stats()).adds, 1);
    assert.equal((await api('/settings')).settings.locale, 'zh-CN');
    await stop();
    await waitFor(async () => f.gateway.peers.size === 0, 'Agent disconnected');
    await assert.rejects(source.search('owner-1', { query: 'Synthetic' }, new AbortController().signal));
    assert.equal(cloudCalls, 0);
    await resources.setMode('owner-1', null);
    await source.search('owner-1', { query: 'Synthetic' }, new AbortController().signal);
    assert.equal(cloudCalls, 1);
    assert.deepEqual(preferences.defaults, { resource: 'hdwing' });
    assert.deepEqual(preferences.selectedSites, ['hdwing']);
    for (const name of ['resource-sites.json', 'journal.json']) {
      const disk = await readFile(join(directory, 'data', name), 'utf8').catch(() => '');
      for (const secret of [key, siteCookie, passkey, 'synthetic-private-token']) assert.ok(!disk.includes(secret));
    }

    await stop();
    console.log(
      `PASS Agent resources: three-site search/detail/prepare → local-ticket download → no secret cloud exposure → encrypted restart → offline fail closed → cloud mode restored`
    );
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit').catch(() => {});
    }
    await mock.close();
    await new Promise((done) => sites.close(done));
    await rm(directory, { recursive: true, force: true });
  }
}
