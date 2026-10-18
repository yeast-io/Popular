import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantMessageReceiver } from './assistant.receiver.js';
import type { AssistantInputWorkflowMessage } from './assistant.type.js';

test('only stable text messages from Telegram or WhatsApp self-chat enter the durable inbox', async () => {
  const inputs: AssistantInputWorkflowMessage[] = [];
  const receiver = new AssistantMessageReceiver({ enqueue: async input => { inputs.push(input); } });
  const message = { channel: 'telegram' as const, senderId: '101', chatId: '101', messageId: '1', messageType: 'text', text: ' hello ' };
  await receiver.receive('alice', message);
  await receiver.receive('bob', { ...message, channel: 'whatsapp', messageType: 'conversation' });
  await receiver.receive('bob', { ...message, channel: 'whatsapp', messageType: 'conversation', isSelfChat: true });
  await receiver.receive('alice', { ...message, messageType: 'photo' });
  await receiver.receive('alice', { ...message, text: '' });
  await receiver.receive('alice', { ...message, messageId: '' });
  assert.deepEqual(inputs.map(input => [input.ownerId, input.channel, input.text]), [
    ['alice', 'telegram', 'hello'], ['bob', 'whatsapp', 'hello'],
  ]);
});

test('inbox persistence failure propagates to the receiving transport', async () => {
  let wakes = 0;
  const receiver = new AssistantMessageReceiver({ enqueue: async () => { throw new Error('storage unavailable'); } }, () => { wakes++; });
  await assert.rejects(receiver.receive('alice', { channel: 'telegram', chatId: '101', senderId: '101',
    messageId: '1', messageType: 'text', text: 'hello' }), /storage unavailable/);
  assert.equal(wakes, 0);
});

test('wakes only after persistence completes and returns without waiting for background work', async () => {
  let persisted = false;
  let release!: () => void;
  const storage = new Promise<void>(resolve => { release = resolve; });
  const wakes: string[] = [];
  const receiver = new AssistantMessageReceiver({ enqueue: async () => {
    await storage;
    persisted = true;
  } }, input => {
    assert.equal(persisted, true);
    wakes.push(input.chatId);
  });
  const receiving = receiver.receive('alice', { channel: 'telegram', chatId: '101', senderId: '101',
    messageId: '1', messageType: 'text', text: 'hello' });
  assert.deepEqual(wakes, []);
  release();
  await receiving;
  assert.deepEqual(wakes, ['101']);
});

test('persistence diagnostics identify storage failure and redact the input from errors', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const logger = { info: (fields: Record<string, unknown>) => { logs.push(fields); }, error: (fields: Record<string, unknown>) => { logs.push(fields); } };
  const receiver = new AssistantMessageReceiver({ enqueue: async () => {
    throw new Error('write failed for private incoming text', { cause: Object.assign(new Error('database unavailable'), { code: 'DB_DOWN' }) });
  } }, () => assert.fail('must not wake after persistence failure'), logger);
  await assert.rejects(receiver.receive('alice', { channel: 'telegram', chatId: '101', senderId: '101',
    messageId: '1', messageType: 'text', text: 'private incoming text' }));
  assert.ok(logs.some(line => line.error && line.stage === 'assistant.inbox.persist' && line.messageId === '1'));
  assert.match(JSON.stringify(logs), /DB_DOWN/);
  assert.ok(!JSON.stringify(logs).includes('private incoming text'));
});
