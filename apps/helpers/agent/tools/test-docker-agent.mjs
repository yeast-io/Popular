// Isolated Docker smoke test. Never uses or removes existing service containers/volumes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const image = process.argv[2] ?? 'popular-agent-web:local';
const prefix = `popular-agent-check-${randomUUID().slice(0, 8)}`;
const data = `${prefix}-data`;
const secrets = `${prefix}-secrets`;
let cookie = '';
let csrf = '';
let base = '';
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function waitFor(test, label) {
  for (let i = 0; i < 100; i++) {
    if (await test()) return;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw Error(`Timed out: ${label}`);
}
async function api(path, method = 'GET', body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      origin: base,
      cookie,
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const value = await response.json();
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return value;
}
try {
  docker('volume', 'create', data);
  docker('volume', 'create', secrets);
  docker(
    'run',
    '--rm',
    '--read-only',
    '--cap-drop=ALL',
    '-v',
    `${secrets}:/run/agent-secrets`,
    image,
    '--init-secrets',
    '/run/agent-secrets'
  );
  // Synthetic, disposable initializer output is read into memory only, never printed.
  const password = docker(
    'run',
    '--rm',
    '--entrypoint',
    'cat',
    '-v',
    `${secrets}:/run/agent-secrets:ro`,
    image,
    '/run/agent-secrets/admin-password'
  );
  // Docker chooses a free loopback port; inspect the temporary container before starting the service.
  docker(
    'create',
    '--name',
    prefix,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--pids-limit=128',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m',
    '-p',
    '127.0.0.1::1423',
    '-v',
    `${data}:/var/lib/popular-agent`,
    '-v',
    `${secrets}:/run/agent-secrets:ro`,
    image
  );
  docker('start', prefix);
  const inspect = JSON.parse(docker('inspect', prefix))[0];
  const port = inspect.NetworkSettings.Ports['1423/tcp'][0].HostPort;
  base = `http://127.0.0.1:${port}`;
  // Recreate only our own container with its assigned origin, keeping the isolated volumes.
  docker('rm', '-f', prefix);
  docker(
    'run',
    '-d',
    '--name',
    prefix,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--pids-limit=128',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m',
    '-p',
    `127.0.0.1:${port}:1423`,
    '-e',
    `AGENT_WEB_ORIGIN=${base}`,
    '-v',
    `${data}:/var/lib/popular-agent`,
    '-v',
    `${secrets}:/run/agent-secrets:ro`,
    image
  );
  const ready = () =>
    fetch(`${base}/health/ready`)
      .then((r) => r.ok)
      .catch(() => false);
  await waitFor(ready, 'Docker ready');
  assert.equal(docker('exec', prefix, 'id', '-u'), '10001');
  assert.equal((await fetch(`${base}/api/settings`)).status, 401);
  assert.match(await (await fetch(base)).text(), /<div id="app"><\/div>/);
  csrf = (await api('/session', 'POST', { password })).csrf;
  await api('/locale', 'PUT', { locale: 'zh-CN' });
  const sentinel = docker('exec', prefix, 'cat', '/var/lib/popular-agent/credentials/key-check.json');
  assert.ok(!sentinel.includes('popular-agent-web-key-v1'));
  docker('restart', '--time', '15', prefix);
  await waitFor(ready, 'Docker restart');
  assert.equal((await api('/session')).authenticated, false);
  csrf = (await api('/session', 'POST', { password })).csrf;
  assert.equal((await api('/settings')).settings.locale, 'zh-CN');
  assert.equal(docker('exec', prefix, 'cat', '/var/lib/popular-agent/credentials/key-check.json'), sentinel);
  await api('/session', 'DELETE');
  assert.equal((await fetch(`${base}/api/settings`, { headers: { cookie } })).status, 401);
  docker('exec', prefix, '/usr/local/bin/popular-agent-web', '--health-check');
  assert.equal(docker('inspect', '--format', '{{.Config.User}}', prefix), '10001:10001');
  console.log('PASS Docker: non-root/read-only → health → login → persistent encrypted volume → restart → logout');
} finally {
  try {
    docker('rm', '-f', prefix);
  } catch {
    /* Only our temporary container. */
  }
  for (const volume of [data, secrets]) {
    try {
      docker('volume', 'rm', volume);
    } catch {
      /* Only our temporary volumes. */
    }
  }
}
