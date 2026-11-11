// Local integration: real Web server/Core/Gateway protocol; simulated account store/downloaders.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
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
for (const provider of ['qbittorrent', 'transmission']) {
  const directory = await mkdtemp(join(tmpdir(), 'popular-web-integration-'));
  const secrets = join(directory, 'secrets');
  const mock = await startMock();
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
    await fetch(`${mock.url}/test/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ issue: true }),
    });
    await waitFor(async () => (await stats()).commands.some((c) => c.state === 'succeeded'), 'download succeeded');
    assert.equal((await stats()).adds, 1);
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
    await api('/session', 'DELETE');
    assert.equal((await fetch(`${base}/api/settings`, { headers: { cookie } })).status, 401);
    await stop();
    console.log(`PASS Web/Core/Gateway ${provider}: login → bind → submit → encrypted restart → same device → logout`);
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit').catch(() => {});
    }
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  }
}
