import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BufferJSON, type UserFacingSocketConfig, type WASocket } from '@whiskeysockets/baileys';
import { createBaileysConnector } from './baileys.connector.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test('self-chat replies cannot loop back into the receiver, even before send resolves', async () => {
  const handlers = new Map<string, (data: unknown) => void>();
  let received = 0;
  const presence: Array<{ state: string; jid: string }> = [];
  const payloads: Array<{ text?: string; image?: Buffer; caption?: string }> = [];
  const self = '61111111111@s.whatsapp.net';
  const connector = createBaileysConnector((() => ({
    user: { id: '61111111111:9@s.whatsapp.net' },
    sendPresenceUpdate: async (state: string, jid: string) => { presence.push({ state, jid }); },
    ev: { on: (event: string, handler: (data: unknown) => void) => handlers.set(event, handler) },
    sendMessage: async (jid: string, content: { text?: string; image?: Buffer; caption?: string }, options: { messageId: string }) => {
      assert.equal(jid, self);
      payloads.push(content);
      handlers.get('messages.upsert')!({ type: 'notify', messages: [{
        key: { id: options.messageId, remoteJid: jid, fromMe: true }, message: content.image ? { imageMessage: { caption: content.caption } } : { conversation: content.text },
      }] });
      return { key: { id: options.messageId } };
    }, end: () => undefined,
  })) as unknown as typeof import('@whiskeysockets/baileys').default);
  const connection = await connector({ load: async () => null, save: async () => undefined, update: () => undefined,
    receive: async () => { received++; } });
  try {
    assert.equal(connection.ownsChat!(self), true);
    assert.equal(connection.ownsChat!('someone@s.whatsapp.net'), false);
    await connection.setTyping!(true);
    await connection.setTyping!(false);
    assert.deepEqual(presence, [{ state: 'composing', jid: self }, { state: 'paused', jid: self }]);
    await connection.sendReply!('AI reply'); await tick();
    const poster = Buffer.from('poster');
    await connection.sendReply!('Movie reason and link', poster); await tick();
    assert.deepEqual(payloads[1], { image: poster, caption: 'Movie reason and link' });
    assert.equal(received, 0);
    handlers.get('messages.upsert')!({ type: 'notify', messages: [{
      key: { id: 'from-phone', remoteJid: self, fromMe: true }, message: { conversation: 'User reply' },
    }] });
    await tick(); assert.equal(received, 1);
  } finally { await connection.stop(false); }
});

test('separate auth/key stores and socket-derived self recipients; no arbitrary recipient or content', async () => {
  const sockets: Array<{ config: UserFacingSocketConfig; handlers: Map<string, (data: never) => void>; sends: Array<{ jid: string; text: string }>; end: boolean }> = [];
  const connector = createBaileysConnector(((config: UserFacingSocketConfig) => {
    const entry = { config, handlers: new Map<string, (data: never) => void>(), sends: [] as Array<{ jid: string; text: string }>, end: false };
    sockets.push(entry);
    const number = sockets.length === 1 ? '61111111111' : '61222222222';
    return {
      user: { id: `${number}:9@s.whatsapp.net` },
      ev: { on: (event: string, listener: (data: never) => void) => entry.handlers.set(event, listener) },
      sendMessage: async (jid: string, content: { text: string }) => { entry.sends.push({ jid, text: content.text }); return { key: { id: number } }; },
      end: () => { entry.end = true; }, logout: async () => undefined,
    } as unknown as WASocket;
  }) as typeof import('@whiskeysockets/baileys').default);
  let aliceState = '';
  let bobState = '';
  const alice = await connector({ load: async () => null, save: async state => { aliceState = state; }, update: () => undefined });
  const bob = await connector({ load: async () => null, save: async state => { bobState = state; }, update: () => undefined });
  try {
    assert.notEqual(aliceState, bobState);
    const a = sockets[0]!;
    const b = sockets[1]!;
    assert.equal(a.config.markOnlineOnConnect, false); assert.equal(a.config.syncFullHistory, false);
    assert.equal(a.handlers.has('messages.upsert'), true);
    await a.config.auth.keys.set({ session: { secret: Buffer.from('alice-only') } });
    assert.deepEqual(await b.config.auth.keys.get('session', ['secret']), {});
    const saved = JSON.parse(aliceState, BufferJSON.reviver);
    assert.equal(saved.keys.session.secret.toString(), 'alice-only');
    assert.ok(!bobState.includes('alice-only'));
    await alice.sendSelf(); await bob.sendSelf();
    assert.equal(a.sends[0]!.jid, '61111111111@s.whatsapp.net');
    assert.equal(b.sends[0]!.jid, '61222222222@s.whatsapp.net');
    assert.ok(a.sends[0]!.text.startsWith('Popular Movie AI Studio WhatsApp connection test'));
    await alice.stop(true);
    await assert.rejects(() => alice.sendSelf());
    assert.equal(a.end, true); assert.equal(b.end, false);
  } finally { await alice.stop(false); await bob.stop(false); }
});

test('QR updates and accepted connection status are scoped to the current socket', async () => {
  let update: (data: unknown) => void = () => undefined;
  const states: Array<{ status: string; qrDataUrl?: string; account?: string }> = [];
  let qrReady!: () => void;
  const qrSeen = new Promise<void>(resolve => { qrReady = resolve; });
  const connector = createBaileysConnector((() => ({
    user: { id: '61123456789:3@s.whatsapp.net' },
    ev: { on: (event: string, handler: (data: unknown) => void) => { if (event === 'connection.update') update = handler; } },
    end: () => undefined,
  })) as unknown as typeof import('@whiskeysockets/baileys').default);
  const connection = await connector({ load: async () => null, save: async () => undefined, update: state => { states.push(state); if (state.status === 'qr') qrReady(); } });
  try {
    update({ qr: 'test-pairing-code' });
    await qrSeen;
    assert.ok(states.at(-1)?.qrDataUrl?.startsWith('data:image/png;base64,'));
    update({ connection: 'open' }); await tick();
    assert.deepEqual(states.at(-1), { status: 'connected', account: '••••6789' });
    await connection.stop(false);
    const count = states.length;
    update({ qr: 'late-private-qr' }); await tick();
    assert.equal(states.length, count);
  } finally { await connection.stop(false); }
});

function fakeSockets() {
  const sockets: Array<{ config: UserFacingSocketConfig; handlers: Map<string, (data: never) => void>; ws: EventEmitter }> = [];
  const makeSocket = ((config: UserFacingSocketConfig) => {
    const handlers = new Map<string, (data: never) => void>();
    const ws = new EventEmitter();
    sockets.push({ config, handlers, ws });
    return { user: { id: '61111111111:9@s.whatsapp.net', lid: '11111@lid' }, ws, ev: { on: (name: string, listener: (data: never) => void) => handlers.set(name, listener) }, end: () => undefined } as unknown as WASocket;
  }) as typeof import('@whiskeysockets/baileys').default;
  const emit = (name: string, data: unknown, index = sockets.length - 1) => sockets[index]!.handlers.get(name)!(data as never);
  return { sockets, makeSocket, emit };
}

test('incoming notify batches include text, wrapped media and phone self-chat; ignore history, groups, protocol and outgoing traffic', async () => {
  const f = fakeSockets();
  const received: import('../../modules/incoming-message.js').IncomingMessage[] = [];
  const connection = await createBaileysConnector(f.makeSocket)({ load: async () => null, save: async () => undefined, update: () => undefined,
    receive: async message => { received.push(message); } });
  const peer = '61222222222@s.whatsapp.net';
  const self = '61111111111@s.whatsapp.net';
  const makeMessage = (id: string, chatId: string, message: object, fromMe = false) => ({ key: { id, remoteJid: chatId, fromMe }, message });
  const batch = [
    makeMessage('1', peer, { conversation: 'hello' }),
    makeMessage('2', peer, { ephemeralMessage: { message: { imageMessage: { caption: 'poster', mediaKey: 'never-log' } } } }),
    makeMessage('3', '123@g.us', { conversation: 'group' }),
    makeMessage('4', 'status@broadcast', { conversation: 'status' }),
    makeMessage('5', peer, { conversation: 'outgoing' }, true),
    makeMessage('6', peer, { protocolMessage: {} }),
    makeMessage('7', peer, { audioMessage: { mediaKey: 'never-log' } }),
    makeMessage('8', self, { conversation: 'from phone' }, true),
    makeMessage('9', '11111@lid', { conversation: 'from phone LID' }, true),
  ];
  try {
    f.emit('messages.upsert', { type: 'append', messages: batch });
    await tick(); assert.equal(received.length, 0);
    f.emit('messages.upsert', { type: 'notify', messages: batch });
    await tick();
    assert.deepEqual(received.map(message => [message.messageId, message.messageType, message.text]), [
      ['1', 'conversation', 'hello'], ['2', 'imageMessage', 'poster'], ['7', 'audioMessage', undefined],
      ['8', 'conversation', 'from phone'], ['9', 'conversation', 'from phone LID'],
    ]);
    assert.ok(received.every(message => message.channel === 'whatsapp'));
    assert.equal(received[0]!.senderId, peer);
    assert.equal(received[3]!.senderId, self);
    assert.ok(!JSON.stringify(received).includes('never-log'));
    await connection.stop(false);
    f.emit('messages.upsert', { type: 'notify', messages: [makeMessage('8', self, { conversation: 'late' })] });
    await tick(); assert.equal(received.length, 5);
  } finally { await connection.stop(false); }
});

test('first QR remains valid after 20 seconds; subsequent QR uses its shorter lifetime and Chrome identity', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-17T00:00:00Z') });
  const f = fakeSockets();
  const states: import('@movie-hub/contract').WhatsAppConfiguration[] = [];
  let qrReady: (() => void) | undefined;
  const connection = await createBaileysConnector(f.makeSocket)({ load: async () => null, save: async () => undefined, update: state => { states.push(state); if (state.status === 'qr') qrReady?.(); } });
  try {
    assert.equal(f.sockets[0]!.config.browser?.[1], 'Chrome');
    let qrSeen = new Promise<void>(resolve => { qrReady = resolve; });
    f.emit('connection.update', { qr: 'first-private-qr' }); await qrSeen;
    assert.equal(Date.parse(states.at(-1)!.qrExpiresAt!) - Date.now(), 60_000);
    t.mock.timers.tick(25_000);
    assert.ok(Date.parse(states.at(-1)!.qrExpiresAt!) > Date.now());
    qrSeen = new Promise<void>(resolve => { qrReady = resolve; });
    f.emit('connection.update', { qr: 'second-private-qr' }); await qrSeen;
    assert.equal(Date.parse(states.at(-1)!.qrExpiresAt!) - Date.now(), 20_000);
  } finally { await connection.stop(false); }
});

test('pairing clears the QR; restart-required waits for credential persistence before opening another socket', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fakeSockets();
  const states: import('@movie-hub/contract').WhatsAppConfiguration[] = [];
  let release!: () => void;
  let writes = 0;
  const connection = await createBaileysConnector(f.makeSocket)({
    load: async () => null,
    save: async () => { if (++writes > 1) await new Promise<void>(resolve => { release = resolve; }); },
    update: state => states.push(state),
  });
  try {
    f.emit('creds.update', { me: { id: '61111111111@s.whatsapp.net' }, registered: true });
    f.emit('connection.update', { isNewLogin: true, qr: undefined });
    assert.deepEqual(states.at(-1), { status: 'pairing' });
    f.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
    await tick(); t.mock.timers.tick(0); await tick();
    assert.equal(f.sockets.length, 1);
    release(); await tick();
    assert.equal(f.sockets.length, 2);
    assert.equal(f.sockets[1]!.config.auth.creds.me?.id, '61111111111@s.whatsapp.net');
    assert.deepEqual(states.at(-1), { status: 'pairing' });
    // A late event from the old socket must not overwrite the new session.
    f.emit('connection.update', { connection: 'open' }, 0);
    assert.deepEqual(states.at(-1), { status: 'pairing' });
  } finally { await connection.stop(false); }
});

test('terminal failures expose only safe reason/code and diagnostics never contain QR or raw errors', async () => {
  const f = fakeSockets();
  const states: import('@movie-hub/contract').WhatsAppConfiguration[] = [];
  const diagnostics: import('../../modules/whatsapp/whatsapp.types.js').WhatsAppDiagnostic[] = [];
  const connection = await createBaileysConnector(f.makeSocket)({
    load: async () => null, save: async () => undefined, update: state => states.push(state), report: event => diagnostics.push(event),
  });
  try {
    f.emit('connection.update', { connection: 'close', lastDisconnect: { error: { message: 'private-credentials-should-never-escape', output: { statusCode: 403 }, data: { qr: 'private-qr' } } } });
    assert.deepEqual(states.at(-1), { status: 'disconnected', failureReason: 'forbidden', disconnectCode: 403 });
    assert.ok(diagnostics.some(event => event.event === 'disconnected' && event.code === 403));
    assert.ok(!JSON.stringify({ states, diagnostics }).includes('private-'));
  } finally { await connection.stop(false); }
});


test('408 diagnostics distinguish exhausted QR refs from transport and operation timeouts without raw error text', async () => {
  for (const [message, reason] of [
    ['QR refs attempts ended', 'qr_refs_exhausted'],
    ['Connection was lost', 'connection_lost'],
    ['Timed Out', 'operation_timeout'],
    ['Pre-key upload timeout', 'prekey_upload_timeout'],
    ['private-arbitrary-error', 'unknown'],
  ]) {
    const f = fakeSockets();
    const diagnostics: import('../../modules/whatsapp/whatsapp.types.js').WhatsAppDiagnostic[] = [];
    const connection = await createBaileysConnector(f.makeSocket)({ load: async () => null, save: async () => undefined, update: () => undefined, report: event => diagnostics.push(event) });
    try {
      f.emit('connection.update', { connection: 'close', lastDisconnect: { error: { message, output: { statusCode: 408 } } } });
      const event = diagnostics.find(event => event.event === 'disconnected');
      assert.equal(event?.reason, reason);
      assert.equal(event?.code, 408);
      assert.equal(event?.paired, false);
      assert.equal(event?.qrCount, 0);
      assert.ok(!JSON.stringify(diagnostics).includes('private-arbitrary-error'));
    } finally { await connection.stop(false); }
  }
});

test('registration refresh observer records only the known event, ignores malformed/paired notifications and is cleaned up', async () => {
  const f = fakeSockets();
  const diagnostics: import('../../modules/whatsapp/whatsapp.types.js').WhatsAppDiagnostic[] = [];
  const connection = await createBaileysConnector(f.makeSocket)({ load: async () => null, save: async () => undefined, update: () => undefined, report: event => diagnostics.push(event) });
  const event = 'CB:notification,type:companion_reg_refresh';
  const ws = f.sockets[0]!.ws;
  try {
    ws.emit(event, { content: [{ tag: 'unrelated' }] });
    assert.equal(diagnostics.filter(item => item.event === 'registration_refresh_received').length, 0);
    ws.emit(event, { attrs: { id: 'private-identity' }, content: [{ tag: 'companion_reg_refresh', content: 'private-payload' }] });
    assert.equal(diagnostics.filter(item => item.event === 'registration_refresh_received').length, 1);
    assert.ok(!JSON.stringify(diagnostics).includes('private-'));
    f.emit('creds.update', { me: { id: '61111111111@s.whatsapp.net' } });
    ws.emit(event, { content: [{ tag: 'companion_reg_refresh' }] });
    assert.equal(diagnostics.filter(item => item.event === 'registration_refresh_received').length, 1);
    await connection.stop(false);
    assert.equal(ws.listenerCount(event), 0);
  } finally { await connection.stop(false); }
});
