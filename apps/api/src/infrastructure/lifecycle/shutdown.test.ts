import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { ApplicationShutdown, installShutdownHandlers } from './shutdown.js';

function fixture(ready = Promise.resolve(), timeout = 30_000) {
  const logs: Array<Record<string, unknown>> = [];
  const logger = {
    info: (fields: Record<string, unknown>) => {
      logs.push(fields);
    },
    error: (fields: Record<string, unknown>) => {
      logs.push(fields);
    },
  };
  const shutdown = new ApplicationShutdown(logger, ready, timeout);
  return { shutdown, logs };
}

test('cleanup runs once in dependency order and continues after a resource fails', async () => {
  const { shutdown, logs } = fixture();
  const closed: string[] = [];
  shutdown.register('redis', 100, () => {
    closed.push('redis');
  });
  shutdown.register('worker', 10, () => {
    closed.push('worker');
    throw new Error('worker close failed');
  });
  shutdown.register('mongo', 90, () => {
    closed.push('mongo');
  });
  const first = shutdown.shutdown('SIGINT');
  assert.equal(shutdown.shutdown('SIGTERM'), first);
  await first;
  assert.deepEqual(closed, ['worker', 'mongo', 'redis']);
  assert.equal(shutdown.exitCode, 1);
  assert.ok(logs.some((line) => line.event === 'resource_close_failed' && line.resource === 'worker'));
});

test('a startup signal stops further startup and waits for initialization before closing resources', async () => {
  let initialized!: () => void;
  const ready = new Promise<void>((resolve) => {
    initialized = resolve;
  });
  const { shutdown } = fixture(ready);
  let closed = false;
  shutdown.register('redis', 100, () => {
    closed = true;
  });
  const stopping = shutdown.shutdown('SIGINT');
  assert.throws(() => shutdown.assertRunning(), /shutting down/);
  await setImmediate();
  assert.equal(closed, false);
  initialized();
  await stopping;
  assert.equal(closed, true);
});

test('shutdown deadline reports the blocked resource and returns failure', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { shutdown, logs } = fixture(Promise.resolve(), 1_000);
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  shutdown.register('worker', 10, () => blocked);
  const stopping = shutdown.shutdown('SIGTERM');
  await setImmediate();
  context.mock.timers.tick(1_000);
  await stopping;
  assert.equal(shutdown.exitCode, 1);
  assert.ok(logs.some((line) => line.event === 'shutdown_timeout' && line.resource === 'worker'));
  finish();
});

test('all supported termination events use the same cleanup path and exit after flushing', async () => {
  for (const reason of [
    'SIGINT',
    'SIGTERM',
    'SIGHUP',
    'SIGQUIT',
    'SIGUSR2',
    'uncaughtException',
    'unhandledRejection',
    'beforeExit',
    'disconnect',
  ]) {
    const { shutdown } = fixture();
    const host = new EventEmitter();
    const order: string[] = [];
    let exitCode: number | undefined;
    Object.assign(host, {
      exit: (code: number) => {
        exitCode = code;
        order.push('exit');
      },
    });
    shutdown.register('worker', 10, () => {
      order.push('worker');
    });
    const handlers = installShutdownHandlers(shutdown, host as unknown as NodeJS.Process, async () => {
      order.push('flush');
    });
    if (reason === 'beforeExit') host.emit(reason, 0);
    else if (reason === 'uncaughtException' || reason === 'unhandledRejection')
      host.emit(reason, new Error('fatal sk-private-key'));
    else host.emit(reason);
    host.emit('SIGTERM');
    for (let index = 0; index < 10; index++) await setImmediate();
    assert.deepEqual(order, ['worker', 'flush', 'exit'], reason);
    assert.equal(exitCode, reason === 'uncaughtException' || reason === 'unhandledRejection' ? 1 : 0, reason);
    handlers.dispose();
    assert.equal(host.listenerCount(reason), 0);
  }
});

test('a real SIGINT closes resources before the child process exits', { timeout: 10_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const source = `
    import { ApplicationShutdown, installShutdownHandlers } from './src/infrastructure/lifecycle/shutdown.ts';
    const logger = { info: (line) => console.log(JSON.stringify(line)), error: (line) => console.error(JSON.stringify(line)) };
    const shutdown = new ApplicationShutdown(logger, Promise.resolve(), 2000);
    const timer = setInterval(() => {}, 1000);
    shutdown.register('telegram_worker', 10, async () => { clearInterval(timer); console.log('POLL_LOCK_RELEASED'); });
    shutdown.register('redis', 100, async () => { console.log('REDIS_CLOSED'); });
    installShutdownHandlers(shutdown);
    console.log('READY');
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }
  );
  let output = '';
  let sent = false;
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 5_000);
  child.stdout.on('data', (data) => {
    output += String(data);
    if (!sent && output.includes('READY')) {
      sent = true;
      child.kill('SIGINT');
    }
  });
  child.stderr.on('data', (data) => {
    output += String(data);
  });
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(result, { code: 0, signal: null }, output);
    assert.ok(output.indexOf('POLL_LOCK_RELEASED') < output.indexOf('REDIS_CLOSED'), output);
    assert.match(output, /shutdown_completed/);
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
