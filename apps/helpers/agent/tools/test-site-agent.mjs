// Real Web/Core/encrypted-store integration against three local synthetic site responses.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const binary = resolve(root, 'apps/helpers/agent/target/debug/popular-agent-web');
const directory = await mkdtemp(join(tmpdir(), 'popular-local-sites-'));
const secrets = join(directory, 'secrets');
let expired = false;
let server;
let cookie = '';
let csrf = '';
const key = 'synthetic-mteam-local-key';
const hdareaKey = 'a'.repeat(32);
const siteCookie = 'uid=synthetic; session=synthetic';
const passkey = 'synthetic-local-passkey';
const observed = [];
const fixture = createServer((request, response) => {
  observed.push({ url: request.url, apiKey: request.headers['x-api-key'], cookie: request.headers.cookie });
  if (expired) {
    response.writeHead(401);
    response.end();
    return;
  }
  if (request.url === '/api/member/profile') {
    assert.equal(request.headers['x-api-key'], key);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ code: '0', data: { id: '8811' } }));
  } else if (request.url === '/api/v1/user/profile') {
    assert.equal(request.headers['x-api-key'], hdareaKey);
    assert.equal(request.headers.cookie, undefined);
    response.end(JSON.stringify({ success: true, code: 0, data: { id: 8811 } }));
  } else if (request.url === '/index.php') {
    assert.equal(request.headers.cookie, siteCookie);
    response.setHeader('content-type', 'text/html');
    response.end(
      "<a href='usercp.php'>profile</a><div id='info_block'><a href='userdetails.php?id=8811'>me</a></div><div id='site_header'><div class='userinfo'><a href='userdetails.php?id=8811'>me</a></div></div>"
    );
  } else {
    response.writeHead(404);
    response.end();
  }
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');
const siteBase = `http://127.0.0.1:${fixture.address().port}/`;
const passwordResult = spawnSync(binary, ['--init-secrets', secrets], {
  cwd: directory,
  env: { ...process.env, LOG_LEVEL: 'off', VERBOSE: 'false' },
  stdio: 'ignore',
});
assert.equal(passwordResult.status, 0);
const password = await readFile(join(secrets, 'admin-password'), 'utf8');
async function waitFor(test, label) {
  for (let i = 0; i < 300; i++) {
    if (await test()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw Error(`Timed out: ${label}`);
}
// Choose a loopback port without exposing a persistent service.
const reserve = createServer();
reserve.listen(0, '127.0.0.1');
await once(reserve, 'listening');
const port = reserve.address().port;
await new Promise((done) => reserve.close(done));
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
  LOG_LEVEL: 'error',
};
async function start(allowDevelopment = true) {
  server = spawn(binary, [], {
    cwd: directory,
    env: { ...env, HELPER_ALLOW_INSECURE_DEV: allowDevelopment ? 'true' : 'false' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let startupError = '';
  server.stderr.on('data', (bytes) => {
    startupError = (startupError + bytes).slice(-65536);
  });
  await waitFor(() => {
    if (server.exitCode !== null) throw Error(`Web exited ${server.exitCode}: ${startupError}`);
    return fetch(`${base}/health/ready`)
      .then((r) => r.ok)
      .catch(() => false);
  }, 'Web ready');
}
async function stop() {
  const exited = once(server, 'exit');
  server.kill('SIGTERM');
  const [code] = await exited;
  assert.equal(code, 0);
  server = undefined;
}
async function api(path, method = 'GET', body, expected = 200) {
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
  assert.equal(response.status, expected);
  const value = await response.json();
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return value;
}
async function login() {
  csrf = (await api('/session', 'POST', { password })).csrf;
}
try {
  await start(false);
  await login();
  const blocked = await api(
    '/resource-sites/configure',
    'POST',
    { site: 'mteam', baseUrl: siteBase, credential: { action: 'set', value: key }, passkey: { action: 'keep' } },
    400
  );
  assert.equal(blocked.error.code, 'invalidUrl');
  assert.equal(observed.length, 0);
  await stop();
  await start();
  await login();
  for (const site of ['mteam', 'hdarea', 'hdwing']) {
    const row = await api('/resource-sites/configure', 'POST', {
      site,
      baseUrl: siteBase,
      credential: { action: 'set', value: site === 'mteam' ? key : site === 'hdarea' ? hdareaKey : siteCookie },
      passkey: site === 'hdarea' ? { action: 'set', value: passkey } : { action: 'keep' },
    });
    assert.equal(row.status, 'configured_valid');
    assert.equal(row.hasCredential, true);
    assert.equal(row.hasPasskey, false);
    assert.equal(row.credential, undefined);
    assert.equal(row.externalUserId, undefined);
    await api('/resource-sites/verify', 'POST', { site });
  }
  await api('/resource-sites/enabled', 'PUT', { site: 'hdarea', enabled: false });
  const publicText = JSON.stringify(await api('/resource-sites'));
  const disk = await readFile(join(directory, 'data/resource-sites.json'), 'utf8');
  for (const secret of [key, hdareaKey, siteCookie, passkey]) {
    assert.ok(!publicText.includes(secret));
    assert.ok(!disk.includes(secret));
  }
  const credentials = join(directory, 'data/credentials');
  for (const name of await readdir(credentials)) {
    const bytes = await readFile(join(credentials, name), 'utf8');
    for (const secret of [key, hdareaKey, siteCookie, passkey]) assert.ok(!bytes.includes(secret));
  }
  assert.equal((await api('/runtime')).service, 'unconfigured');
  await stop();
  await start();
  assert.equal((await api('/session')).authenticated, false);
  await login();
  const restored = await api('/resource-sites');
  assert.equal(restored.filter((row) => row.hasCredential).length, 3);
  assert.equal(restored.find((row) => row.site === 'hdarea').enabled, false);
  expired = true;
  const error = await api('/resource-sites/verify', 'POST', { site: 'hdwing' }, 502);
  assert.equal(error.error.code, 'siteAuthentication');
  assert.equal((await api('/session')).authenticated, true);
  assert.equal((await api('/resource-sites')).find((row) => row.site === 'hdwing').status, 'configured_invalid');
  for (const site of ['mteam', 'hdarea', 'hdwing']) await api('/resource-sites/remove', 'POST', { site });
  assert.ok((await api('/resource-sites')).every((row) => !row.hasCredential));
  assert.deepEqual(await readdir(credentials), ['key-check.json']);
  assert.ok(observed.every((request) => !JSON.stringify(request).includes(passkey)));
  await stop();
  console.log(
    'PASS local sites: authenticated Web → three real Core verifiers → encrypted credentials → restart → enable state → expired login → delete'
  );
} finally {
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGKILL');
    await exited.catch(() => {});
  }
  await new Promise((done) => fixture.close(done));
  await rm(directory, { recursive: true, force: true });
}
