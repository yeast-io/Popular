import assert from 'node:assert/strict';
import test from 'node:test';
import { SocketRpc, RpcError } from './socket-rpc.service.js';
import type { RpcOptions, RpcTransport } from './socket-rpc.types.js';

function pair(handler: RpcOptions['handle'], options: Partial<RpcOptions> = {}) {
  const a: Array<(s: string) => void> = [];
  const b: Array<(s: string) => void> = [];
  let closed = false;
  const transport = (own: typeof a, other: typeof b): RpcTransport => {
    return ({
      open: () => !closed, close: () => { closed = true; }, bufferedBytes: () => 0,
      onMessage: (h) => {
        own.push(h);
      }, onClose() {}, send: (text) => {
        queueMicrotask(() => other.forEach((h) => h(text)));
      },
    });
  };
  const diagnostics = { verbose: false, info() {}, error() {} };
  const left = new SocketRpc({ transport: transport(a, b), allowed: ['__reverse__'], handle: async (_c, p) => {
    return p;
  }, diagnostics });
  const right = new SocketRpc({ transport: transport(b, a), allowed: ['__work__'], handle: handler, diagnostics, ...options });
  return { left, right, inject: (text: string) => {
    return b.forEach((h) => h(text));
  }, close: () => {
    left.disconnect();
    right.disconnect();
  } };
}
test('multiplexes out-of-order bidirectional RPC without blocking requests behind a slow request', async (t) => {
  let release: (value: unknown) => void = () => {};
  const p = pair(
    async (_c, payload) => payload === 'slow' ? new Promise((resolve) => { release = resolve; }) : payload
  );
  t.after(p.close);
  const slow = p.left.call('__work__', 'slow');
  assert.equal(await p.left.call('__work__', 'fast'), 'fast');
  assert.equal(await p.right.call('__reverse__', 'reverse'), 'reverse');
  release('done');
  assert.equal(await slow, 'done');
});
test('same message identity is cached, conflicting payload is rejected, invalid direction is rejected', async (t) => {
  let calls = 0;
  const p = pair(async () => ++calls);
  t.after(p.close);
  assert.equal(await p.left.call('__work__', { x: 1 }, 'trace', 'same'), 1);
  assert.equal(await p.left.call('__work__', { x: 1 }, 'trace', 'same'), 1);
  await assert.rejects(p.left.call('__work__', { x: 2 }, 'trace', 'same'), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(p.left.call('__forbidden__', {}), { code: 'RPC_DIRECTION_FORBIDDEN' });
});
test('transient replies are not cached and timeout remains uncertain', async (t) => {
  let calls = 0;
  const p = pair(
    async () => {
      if (++calls === 1) throw new RpcError('SERVICE_BUSY', 'not_applied');
      return calls;
    });
  t.after(
    p.close
  );
  await assert.rejects(p.left.call('__work__', {}, 'trace', 'retry'), { code: 'SERVICE_BUSY', effect: 'not_applied' });
  assert.equal(await p.left.call('__work__', {}, 'trace', 'retry'), 2);
  const stalled = pair(async () => new Promise(() => {}));
  t.after(stalled.close);
  stalled.left.options.timeoutMs = 20;
  await assert.rejects(stalled.left.call('__work__', {}), { code: 'RPC_TIMEOUT', effect: 'unknown' });
});
test('bounds concurrent requests and outgoing buffers and drains committed work on disconnect', async (t) => {
  let release: (v: unknown) => void = () => {};
  const p = pair(async () => new Promise((resolve) => {
    release = resolve;
  }), { maxInFlight: 1 });
  t.after(p.close);
  const first = p.left.call('__work__', {});
  const caught = assert.rejects(first, { code: 'RPC_CONNECTION_CLOSED' });
  await assert.rejects(p.left.call('__work__', {}), { code: 'SERVICE_BUSY', effect: 'not_applied' });
  p.left.disconnect();
  p.right.disconnect();
  release('persisted');
  await p.right.drain();
  await caught;
  const q = pair(async () => null);
  t.after(q.close);
  q.left.options.transport.bufferedBytes = () => 2_000_000;
  await assert.rejects(q.left.call('__work__', {}), { code: 'SERVICE_BUSY' });
});
