import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { AssistantWorker } from './assistant.worker.js';
import type { AssistantConversation, AssistantJob, AssistantQueue } from './assistant.queue.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (check()) return;
    await setTimeout(1);
  }
  assert.fail('Worker did not reach the expected state within 1 second');
}

function redisFixture() {
  const locks = new Map<string, string>();
  return {
    locks,
    ttl: async (key: string) => locks.has(key) ? 60 : -2,
    set: async (key: string, token: string) => {
      if (locks.has(key)) return null;
      locks.set(key, token);
      return 'OK';
    },
    eval: async (_script: string, count: number, ...args: string[]) => {
      const keys = args.slice(0, count);
      const token = args[count];
      if (keys.some(key => locks.get(key) !== token)) return 0;
      if (count === 1) locks.delete(keys[0]!);
      return 1;
    },
  };
}

type Row = AssistantJob & { status: 'pending' | 'processing' | 'delivered' | 'failed'; due: boolean; expired: boolean; lease?: string };
const same = (a: AssistantConversation, b: AssistantConversation) =>
  a.ownerId === b.ownerId && a.channel === b.channel && a.chatId === b.chatId;

function fixture(redis = redisFixture(), concurrency = 2, lockTraceEnabled = false, scanTraceEnabled = false) {
  const rows: Row[] = [];
  const generated: string[] = [];
  const sent: string[] = [];
  const events: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const logger = { info: (fields: Record<string, unknown>) => { logs.push(fields); }, error: (fields: Record<string, unknown>) => { logs.push(fields); } };
  let bound = true;
  let failSend = false;
  let failGenerate = false;
  let loseMessageLease = false;
  let generation: (() => Promise<void>) | undefined;
  let signal: AbortSignal | undefined;
  const head = (conversation: AssistantConversation) => rows.find(row =>
    same(row.input, conversation) && ['pending', 'processing'].includes(row.status));
  const queue: AssistantQueue = {
    enqueue: async input => { rows.push({ id: input.messageId, input, attempts: 0, status: 'pending', due: true, expired: false }); },
    readyConversations: async () => rows.filter(row => head(row.input) === row &&
      (row.status === 'pending' && row.due || row.status === 'processing' && row.expired)).map(row => row.input),
    claim: async (conversation, lease) => {
      const row = head(conversation);
      if (!row || row.status === 'pending' && !row.due || row.status === 'processing' && !row.expired) return null;
      row.status = 'processing';
      row.lease = lease;
      row.expired = false;
      row.attempts++;
      return row;
    },
    renew: async () => !loseMessageLease,
    history: async () => [],
    saveResult: async (id, lease, result) => {
      const row = rows.find(row => row.id === id && row.lease === lease)!;
      row.result = result;
      return true;
    },
    delivered: async id => { rows.find(row => row.id === id)!.status = 'delivered'; },
    retry: async (id, _lease, exhausted) => {
      const row = rows.find(row => row.id === id)!;
      row.status = exhausted ? 'failed' : 'pending';
      row.due = false;
    },
  };
  const worker = new AssistantWorker(redis as never, queue, { run: async (input, _history, currentSignal) => {
    signal = currentSignal;
    generated.push(input.messageId);
    await generation?.();
    if (failGenerate) throw new Error('secret upstream text');
    return { replyText: 'hello back' };
  } }, async (input, text) => {
    assert.ok(!text.includes('secret'));
    sent.push(input.messageId);
    if (failSend) throw new Error('network failed');
  }, async () => bound, event => events.push(event), { maxConcurrency: concurrency, scanIntervalMs: 60_000, scanTraceEnabled }, logger, lockTraceEnabled);
  const add = async (id: string, chatId = '101', ownerId = 'alice', channel: 'telegram' | 'whatsapp' = 'telegram') => {
    const input = { ownerId, channel, chatId, messageId: id, text: 'hello', receivedAt: '2026-10-18T00:00:00.000Z' };
    await queue.enqueue(input);
    return input;
  };
  return { worker, queue, rows, generated, sent, events, add, redis, logs,
    get signal() { return signal; },
    block: (callback: () => Promise<void>) => { generation = callback; },
    failSend: () => { failSend = true; }, restoreSend: () => { failSend = false; },
    failGenerate: () => { failGenerate = true; }, unbind: () => { bound = false; },
    loseLease: () => { loseMessageLease = true; },
  };
}

test('wake begins immediately without waiting for a scan, and duplicate wakes preserve conversation order', async t => {
  const f = fixture();
  f.worker.start();
  t.after(() => f.worker.stop());
  const gate = deferred();
  f.block(() => gate.promise);
  const first = await f.add('1');
  f.worker.wake(first);
  await waitFor(() => f.generated.length === 1);
  const second = await f.add('2');
  f.worker.wake(second);
  f.worker.wake(first);
  await setImmediate();
  assert.deepEqual(f.generated, ['1']);
  gate.resolve();
  await waitFor(() => f.sent.length === 2);
  assert.deepEqual(f.generated, ['1', '2']);
});

test('different conversations run concurrently while the local limit queues excess work', async t => {
  const f = fixture();
  const gate = deferred();
  f.block(() => gate.promise);
  f.worker.start();
  t.after(() => f.worker.stop());
  for (let index = 0; index < 3; index++) f.worker.wake(await f.add(String(index), String(index)));
  await waitFor(() => f.generated.length === 2);
  await setImmediate();
  assert.equal(f.generated.length, 2);
  gate.resolve();
  await waitFor(() => f.sent.length === 3);
});

test('API instances share conversation leases and the concurrency cap', async t => {
  const redis = redisFixture();
  const f = fixture(redis, 1);
  const generated: string[] = [];
  const sent: string[] = [];
  const otherWorker = new AssistantWorker(redis as never, f.queue, { run: async input => {
    generated.push(input.messageId);
    return { replyText: 'reply' };
  } }, async input => { sent.push(input.messageId); }, async () => true, () => undefined,
  { maxConcurrency: 1, scanIntervalMs: 60_000 });
  const gate = deferred();
  f.block(() => gate.promise);
  const first = await f.add('1');
  f.worker.start();
  await waitFor(() => f.generated.length === 1);
  const other = await f.add('2', '202');
  otherWorker.start();
  t.after(async () => { gate.resolve(); await Promise.all([f.worker.stop(), otherWorker.stop()]); });
  otherWorker.wake(first);
  otherWorker.wake(other);
  await setTimeout(10);
  assert.equal(generated.length, 0);
  gate.resolve();
  await waitFor(() => redis.locks.size === 0);
  await otherWorker.tick();
  await waitFor(() => sent.length === 1);
  assert.deepEqual(generated, ['2']);
  assert.deepEqual(f.generated, ['1']);
});

test('recovery scan picks up both missed wakeups and expired processing leases', async t => {
  const f = fixture();
  await f.add('pending');
  await f.add('abandoned', '202');
  f.rows[1]!.status = 'processing';
  f.rows[1]!.expired = true;
  f.rows[1]!.result = { replyText: 'persisted before crash' };
  f.worker.start();
  t.after(() => f.worker.stop());
  await waitFor(() => f.sent.length === 2);
  assert.deepEqual(f.generated, ['pending']);
  assert.equal(f.rows[1]!.attempts, 1);
});

test('delivery retries reuse the reply and delayed retries block later messages', async t => {
  const f = fixture();
  await f.add('1');
  const later = await f.add('2');
  f.failSend();
  f.worker.start();
  t.after(() => f.worker.stop());
  await waitFor(() => f.rows[0]!.status === 'pending' && !f.rows[0]!.due);
  f.worker.wake(later);
  await f.worker.tick();
  await setTimeout(10);
  assert.deepEqual(f.generated, ['1']);
  f.restoreSend();
  f.rows[0]!.due = true;
  await f.worker.tick();
  await waitFor(() => f.rows.every(row => row.status === 'delivered'));
  assert.deepEqual(f.generated, ['1', '2']);
  assert.deepEqual(f.sent, ['1', '1', '2']);
});

test('conversation identity includes owner and channel', async t => {
  const f = fixture(undefined, 3);
  const gate = deferred();
  f.block(() => gate.promise);
  await f.add('alice-tg');
  await f.add('bob-tg', '101', 'bob');
  await f.add('alice-wa', '101', 'alice', 'whatsapp');
  f.worker.start();
  t.after(() => f.worker.stop());
  await waitFor(() => f.generated.length === 3);
  gate.resolve();
  await waitFor(() => f.sent.length === 3);
});

test('unbound users cannot call AI or send', async t => {
  const f = fixture();
  await f.add('1');
  f.unbind();
  f.worker.start();
  t.after(() => f.worker.stop());
  await waitFor(() => f.rows[0]!.status === 'failed');
  assert.equal(f.generated.length, 0);
  assert.equal(f.sent.length, 0);
});

test('provider failures are persisted as safe replies', async t => {
  const f = fixture();
  await f.add('1');
  f.failGenerate();
  f.worker.start();
  t.after(() => f.worker.stop());
  await waitFor(() => f.rows[0]!.status === 'delivered');
  assert.match(f.rows[0]!.result!.replyText, /未完成/);
  assert.ok(f.events.includes('assistant_generation_failed'));
});

test('lost message leases prevent delivery', async t => {
  const f = fixture();
  await f.add('1');
  f.loseLease();
  f.worker.start();
  t.after(() => f.worker.stop());
  await waitFor(() => f.events.includes('assistant_delivery_or_execution_failed'));
  assert.equal(f.sent.length, 0);
});

test('shutdown aborts active generation and leaves the persisted job recoverable', async () => {
  const f = fixture();
  const gate = deferred();
  f.block(() => gate.promise);
  await f.add('1');
  f.worker.start();
  await waitFor(() => f.generated.length === 1);
  const stopped = f.worker.stop();
  assert.equal(f.signal!.aborted, true);
  gate.resolve();
  await stopped;
  assert.equal(f.sent.length, 0);
  assert.equal(f.rows[0]!.status, 'pending');
  assert.equal(f.redis.locks.size, 0);
});

test('notifications received before startup remain queued', async t => {
  const f = fixture();
  f.worker.wake(await f.add('1'));
  assert.equal(f.generated.length, 0);
  f.worker.start();
  t.after(() => f.worker.stop());
  await waitFor(() => f.sent.length === 1);
});

test('heartbeat renews active work and lease loss aborts generation before delivery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const gate = deferred();
  f.block(() => gate.promise);
  await f.add('1');
  f.worker.start();
  t.after(async () => { gate.resolve(); await f.worker.stop(); });
  for (let index = 0; index < 20; index++) await setImmediate();
  assert.equal(f.generated.length, 1);
  t.mock.timers.tick(15_000);
  for (let index = 0; index < 20; index++) await setImmediate();
  assert.equal(f.signal!.aborted, false);
  f.redis.locks.clear();
  t.mock.timers.tick(15_000);
  for (let index = 0; index < 20; index++) await setImmediate();
  assert.equal(f.signal!.aborted, true);
  gate.resolve();
  for (let index = 0; index < 20; index++) await setImmediate();
  assert.equal(f.sent.length, 0);
});

test('a message arriving while a conversation is releasing its lock is not stranded until scanning', async t => {
  const redis = redisFixture();
  const release = redis.eval;
  const gate = deferred();
  let releasing = false;
  redis.eval = async (script, count, ...args) => {
    if (count === 1 && args[0]!.includes(':conversation:') && !releasing) {
      releasing = true;
      await gate.promise;
    }
    return release(script, count, ...args);
  };
  const f = fixture(redis);
  await f.add('1');
  f.worker.start();
  t.after(async () => { gate.resolve(); await f.worker.stop(); });
  await waitFor(() => releasing);
  f.worker.wake(await f.add('2'));
  gate.resolve();
  await waitFor(() => f.sent.length === 2);
  assert.deepEqual(f.sent, ['1', '2']);
});

test('job diagnostics correlate claim, generation, persistence and delivery without reply or input text', async t => {
  const f = fixture();
  await f.add('message-1');
  f.worker.start();
  t.after(() => f.worker.stop());
  await waitFor(() => f.rows[0]!.status === 'delivered');
  for (const stage of ['assistant.job.claimed', 'assistant.history.load.completed', 'assistant.workflow.run.completed',
    'assistant.result.save.completed', 'assistant.reply.send.completed', 'assistant.job.delivered.completed']) {
    assert.ok(f.logs.some(line => line.stage === stage && line.messageId === 'message-1' && line.jobId === 'message-1'), stage);
  }
  assert.ok(!JSON.stringify(f.logs).includes('hello'));
});

test('delivery errors log the precise failing stage and retain a reusable reply', async t => {
  const f = fixture();
  await f.add('message-1');
  f.failSend();
  f.worker.start();
  t.after(() => f.worker.stop());
  await waitFor(() => f.rows[0]!.status === 'pending' && !f.rows[0]!.due);
  const failure = f.logs.find(line => line.error && line.event === 'assistant_job');
  assert.equal(failure?.stage, 'assistant.reply.send');
  assert.equal(failure?.messageId, 'message-1');
  assert.match(JSON.stringify(failure), /network failed/);
  assert.match(JSON.stringify(failure), /stack/);
  assert.ok(f.rows[0]!.result);
});

test('a handled AI failure does not obscure a later delivery failure stage', async t => {
  const f = fixture();
  await f.add('message-1');
  f.failGenerate();
  f.failSend();
  f.worker.start();
  t.after(() => f.worker.stop());
  await waitFor(() => f.rows[0]!.status === 'pending' && !f.rows[0]!.due);
  const failures = f.logs.filter(line => line.error);
  assert.ok(failures.some(line => line.event === 'assistant_generation_failed' && line.stage === 'assistant.workflow.run'));
  assert.ok(failures.some(line => line.event === 'assistant_job' && line.stage === 'assistant.reply.send'));
});

test('assistant conversation and capacity locks share the tracing switch', async t => {
  for (const enabled of [false, true]) {
    const f = fixture(undefined, 2, enabled);
    await f.add('1');
    f.worker.start();
    t.after(() => f.worker.stop());
    await waitFor(() => f.rows[0]!.status === 'delivered' && f.redis.locks.size === 0);
    const lockLogs = f.logs.filter(line => line.event === 'redis_lock');
    if (!enabled) assert.deepEqual(lockLogs, []);
    else {
      for (const lockType of ['assistant_conversation', 'assistant_capacity']) {
        assert.ok(lockLogs.some(line => line.lockType === lockType && line.outcome === 'acquired'));
        assert.ok(lockLogs.some(line => line.lockType === lockType && line.outcome === 'released'));
      }
      assert.ok(lockLogs.some(line => line.outcome === 'renewed' && (line.keys as string[]).length === 2));
    }
  }
});

test('recovery scan tracing follows its switch while task progress and failures stay visible', async t => {
  for (const enabled of [false, true]) {
    const f = fixture(undefined, 2, false, enabled);
    await f.add('1');
    f.worker.start();
    t.after(() => f.worker.stop());
    await waitFor(() => f.rows[0]!.status === 'delivered');
    assert.equal(f.logs.some(line => line.event === 'assistant_scan_completed'), enabled);
    assert.equal(f.logs.some(line => line.event === 'assistant_wake'), enabled);
    assert.ok(f.logs.some(line => line.stage === 'assistant.job.claimed'));
  }
  const f = fixture();
  f.queue.readyConversations = async () => { throw new Error('scan database unavailable'); };
  f.worker.start();
  t.after(() => f.worker.stop());
  await waitFor(() => f.logs.some(line => line.event === 'assistant_scan_failed'));
});
