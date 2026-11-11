// Real Web/Core/Gateway observability; disposable data and simulated accounts only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-gateway.mjs';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const binary = resolve(root, 'apps/helpers/agent/target/debug/popular-agent-web');
const password = 'DO_NOT_LOG-management-password';
const username = 'DO_NOT_LOG-username';
const correlationId = '8e861af1-c7ca-48eb-9045-963576c3b089';
async function waitFor(test, label) {
  for (let i = 0; i < 300; i++) {
    if (await test()) return;
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
for (const [verbose, level] of [['true', 'info'], ['false', 'info'], ['true', 'error'], ['true', 'off']]) {
  const directory = await mkdtemp(join(tmpdir(), 'popular-web-diagnostics-'));
  const mock = verbose === 'true' && level === 'info' ? await startMock() : undefined;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  let cookie = '';
  let csrf = '';
  const child = spawn(binary, [], { cwd: directory, env: {
    ...process.env,
    AGENT_WEB_BIND: `127.0.0.1:${port}`,
    AGENT_WEB_ORIGIN: base,
    AGENT_DATA_DIR: join(directory, 'data'),
    AGENT_WEB_STATIC_DIR: resolve(root, 'apps/helpers/agent/web/dist'),
    AGENT_MASTER_KEY_FILE: join(directory, 'secrets/master.key'),
    AGENT_ADMIN_PASSWORD_FILE: join(directory, 'secrets/admin-password'),
    WEB_LOGIN_USER: username,
    WEB_LOGIN_PASSWORD: password,
    HELPER_ALLOW_INSECURE_DEV: 'true',
    VERBOSE: verbose,
    LOG_LEVEL: level,
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    logs += chunk;
  });
  const events = () => logs.split('\n').slice(0, -1).filter(Boolean).map((line) => JSON.parse(line));
  const stop = async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.kill('SIGTERM');
    try {
      const [code] = await exited;
      assert.equal(code, 0);
    } finally {
      clearTimeout(timer);
    }
  };
  const request = (path, method = 'GET', body) => fetch(`${base}${path}`, {
    method,
    headers: { origin: base, cookie, ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
  });
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw Error('Web process exited before readiness');
      return fetch(`${base}/health/ready`).then((r) => r.ok).catch(() => false);
    }, 'Web ready');
    const denied = await fetch(`${base}/api/settings`, { headers: { 'x-request-id': correlationId } });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('x-request-id'), correlationId);
    if (mock) {
      assert.equal((await request('/unknown/DO_NOT_LOG?token=DO_NOT_LOG')).status, 404);
      const response = await request('/api/session', 'POST', { username, password });
      assert.equal(response.status, 200);
      cookie = response.headers.get('set-cookie').split(';')[0];
      csrf = (await response.json()).csrf;
      const stream = await request('/api/events');
      const reader = stream.body.getReader();
      await reader.read();
      await reader.cancel();
      const connected = await request('/api/gateway/connect', 'POST', { gatewayUrl: mock.url, locale: 'en-US', apiKey: { action: 'set', value: 'fixture-api-key' } });
      assert.equal(connected.status, 200);
      await waitFor(() => events().some((e) => e.stage === 'gateway.websocket.received' && e.command === '__queue_snapshot__'), 'Gateway messages');
      await waitFor(() => events().some((e) => e.stage === 'gateway.websocket.received' && e.frameType === 'pong'), 'Gateway heartbeat');
      await fetch(`${mock.url}/test/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disconnect: true }) });
      await waitFor(() => events().filter((e) => e.stage === 'gateway.websocket.send.completed' && e.command === '__authenticate__').length >= 2, 'Gateway reconnect');
      const disconnected = await request('/api/gateway/disconnect', 'POST');
      assert.equal(disconnected.status, 200);
    }
    await stop();
    const captured = events();
    const details = captured.filter((e) => e.host === 'web');
    assert.ok(!logs.includes('DO_NOT_LOG'));
    assert.ok(!logs.includes('fixture-api-key'));
    if (mock) {
      const listening = details.find((e) => e.stage === 'web.server.listening');
      assert.equal(listening.bindAddress, '127.0.0.1');
      assert.equal(listening.port, port);
      assert.equal(listening.origin, base);
      assert.ok(Number.isInteger(listening.timestampMs));
      const access = details.filter((e) => e.correlationId === correlationId);
      assert.ok(access.some((e) => e.stage === 'http.access.started' && e.route === '/api/settings' && e.method === 'GET'));
      assert.ok(access.some((e) => e.stage === 'http.access.responded' && e.httpStatus === 401 && e.outcome === 'failed' && typeof e.durationMs === 'number'));
      assert.ok(details.some((e) => e.stage === 'http.access.responded' && e.route === '/health/ready' && e.httpStatus === 200));
      assert.ok(details.some((e) => e.stage === 'http.events.started'));
      assert.ok(details.some((e) => e.stage === 'http.events.closed'));
      assert.ok(details.some((e) => e.stage === 'gateway.http.completed' && e.httpStatus === 200 && e.hostname === '127.0.0.1'));
      assert.ok(details.some((e) => e.stage === 'gateway.websocket.connect.completed' && e.httpStatus === 101));
      for (const command of ['__authenticate__', '__auth_proof__', '__queue_request__']) {
        assert.ok(details.some((e) => e.stage === 'gateway.websocket.send.completed' && e.command === command && e.direction === 'outbound' && e.messageId));
      }
      for (const command of ['__auth_challenge__', '__auth_result__', '__queue_snapshot__']) {
        assert.ok(details.some((e) => e.stage === 'gateway.websocket.received' && e.command === command && e.direction === 'inbound' && e.messageId));
      }
      assert.ok(details.some((e) => e.frameType === 'ping' && e.direction === 'outbound'));
      assert.ok(details.some((e) => e.frameType === 'close' && e.direction === 'inbound'));
      assert.ok(captured.some((e) => e.stage === 'gateway.retry.scheduled'));
      assert.ok(details.some((e) => e.stage === 'web.shutdown.requested' && e.signal === 'SIGTERM'));
      assert.ok(details.some((e) => e.stage === 'web.server.stopped' && e.outcome === 'completed'));
      assert.ok(details.every((e) => !Object.hasOwn(e, 'payload')));
    } else {
      assert.equal(details.length, 0);
      assert.equal(captured.some((e) => e.level === 'error'), level !== 'off');
    }
    console.log(`PASS Web diagnostics: VERBOSE=${verbose}, LOG_LEVEL=${level}`);
  } finally {
    try {
      await stop();
    } finally {
      await mock?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
}
