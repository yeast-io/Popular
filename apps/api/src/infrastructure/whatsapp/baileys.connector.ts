import makeWASocket, { BufferJSON, Browsers, DisconnectReason, initAuthCreds, jidNormalizedUser, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataSet, type BinaryNode } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import type { WhatsAppConfiguration } from '@movie-hub/contract';
import type { WhatsAppConnector, WhatsAppDiagnostic } from '../../modules/whatsapp/whatsapp.types.js';

// Outbound only: recipients are always derived from the linked account.
export function createBaileysConnector(makeSocket: typeof makeWASocket = makeWASocket): WhatsAppConnector {
  return async options => {
    const saved = await options.load();
    const data: { creds: AuthenticationCreds; keys: Record<string, Record<string, unknown>> } = saved
      ? JSON.parse(saved, BufferJSON.reviver)
      : { creds: initAuthCreds(), keys: {} };
    let stopped = false;
    let socket: ReturnType<typeof makeWASocket> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let writes = Promise.resolve();
    let removeRefreshObserver: (() => void) | undefined;
    const fail = (failureReason: 'storage_error' | 'connection_error' = 'connection_error') => {
      if (stopped) return;
      stopped = true;
      if (reconnect) clearTimeout(reconnect);
      removeRefreshObserver?.();
      options.report?.({ event: failureReason });
      options.update({ status: 'error', failureReason });
      socket?.end(undefined);
    };
    const persist = () => {
      if (stopped) return Promise.reject(new Error('WhatsApp session stopped'));
      const snapshot = JSON.stringify(data, BufferJSON.replacer);
      writes = writes.then(() => options.save(snapshot));
      void writes.catch(() => fail('storage_error'));
      return writes;
    };
    const auth: AuthenticationState = {
      creds: data.creds,
      keys: {
        get: async (type, ids) => {
          const result: Record<string, unknown> = {};
          for (const id of ids) {
            let value = data.keys[type]?.[id];
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value as Record<string, unknown>);
            if (value) result[id] = value;
          }
          return result as never;
        },
        set: async (updates: SignalDataSet) => {
          for (const [type, entries] of Object.entries(updates)) {
            const keys = data.keys[type] ??= {};
            for (const [id, value] of Object.entries(entries ?? {})) {
              if (value == null) delete keys[id];
              else keys[id] = value;
            }
          }
          await persist();
        },
      },
    };
    await persist();
    function open() {
      if (stopped) return;
      removeRefreshObserver?.();
      const openedAt = Date.now();
      options.report?.({ event: 'connecting' });
      options.update({ status: data.creds.me ? 'pairing' : 'connecting' });
      const current = makeSocket({
        auth, logger: pino({ level: 'silent' }), browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false,
        connectTimeoutMs: 30_000, defaultQueryTimeoutMs: 20_000,
        getMessage: async () => undefined,
      });
      socket = current;
      let qrVersion = 0;
      let qrCount = 0;
      let closed = false;
      // Observe only the notification type/known child tags. Never log the node.
      const refreshEvent = 'CB:notification,type:companion_reg_refresh';
      const observeRefresh = (node: BinaryNode) => {
        if (stopped || closed || socket !== current || data.creds.me) return;
        if (!Array.isArray(node.content) || !node.content.some(child => child.tag === 'companion_reg_refresh' || child.tag === 'pair-device-rotate-qr')) return;
        options.report?.({ event: 'registration_refresh_received', elapsedMs: Date.now() - openedAt, qrCount, paired: false });
      };
      current.ws?.on(refreshEvent, observeRefresh);
      removeRefreshObserver = () => { current.ws?.off(refreshEvent, observeRefresh); };
      current.ev.on('creds.update', update => {
        if (stopped || socket !== current) return;
        Object.assign(data.creds, update);
        void persist().catch(() => fail('storage_error'));
      });
      current.ev.on('connection.update', update => {
        void (async () => {
          if (stopped || closed || socket !== current) return;
          if (update.qr) {
            const version = ++qrVersion;
            // Match the installed Baileys socket: first ref 60s, subsequent refs 20s.
            const qrExpiresAt = new Date(Date.now() + (qrCount++ === 0 ? 60_000 : 20_000)).toISOString();
            const qrDataUrl = await QRCode.toDataURL(update.qr, { width: 280, margin: 2 });
            if (!stopped && !closed && socket === current && version === qrVersion) {
              options.report?.({ event: 'qr_issued' });
              options.update({ status: 'qr', qrDataUrl, qrExpiresAt });
            }
          }
          if (update.isNewLogin) {
            ++qrVersion;
            options.report?.({ event: 'pairing_accepted' });
            options.update({ status: 'pairing' });
          }
          if (update.connection === 'open') {
            ++qrVersion;
            attempts = 0;
            await persist();
            options.report?.({ event: 'connected' });
            if (!stopped && !closed && socket === current) options.update({ status: 'connected', account: maskedAccount(current.user?.id) });
          }
          if (update.connection === 'close') {
            closed = true;
            removeRefreshObserver?.();
            ++qrVersion;
            const rawCode = (update.lastDisconnect?.error as { output?: { statusCode?: unknown } } | undefined)?.output?.statusCode;
            const code = typeof rawCode === 'number' && Number.isInteger(rawCode) && rawCode >= 0 && rawCode <= 9999 ? rawCode : undefined;
            const codeField = code === undefined ? {} : { code };
            options.report?.({ event: 'disconnected', ...codeField, attempt: attempts,
              reason: diagnosticReason(update.lastDisconnect?.error), elapsedMs: Date.now() - openedAt, qrCount, paired: Boolean(data.creds.me) });
            // 515 follows successful pairing: finish credential writes, then reconnect.
            attempts++;
            if (code === DisconnectReason.restartRequired && attempts <= 5) {
              options.update({ status: 'pairing' });
            } else {
              const failureReason = disconnectReason(code);
              const state = { failureReason, ...(code === undefined ? {} : { disconnectCode: code }) };
              if (['logged_out', 'bad_session', 'connection_replaced', 'forbidden'].includes(failureReason) || attempts > 5) {
                options.update({ status: 'disconnected', ...state });
                return;
              }
              options.update({ status: 'connecting', ...state });
            }
            if (reconnect) clearTimeout(reconnect);
            options.report?.({ event: 'reconnect_scheduled', ...codeField, attempt: attempts });
            reconnect = setTimeout(() => { void writes.then(open).catch(() => fail('connection_error')); }, code === DisconnectReason.restartRequired ? 0 : Math.min(30_000, 1_000 * 2 ** attempts));
            reconnect.unref();
          }
        })().catch(() => fail('connection_error'));
      });
    }
    open();
    return {
      async sendSelf() {
        const current = socket;
        if (stopped || !current?.user?.id) throw new Error('WhatsApp not connected');
        // The recipient is derived exclusively from this owner's linked identity.
        const jid = jidNormalizedUser(current.user.id);
        const result = await current.sendMessage(jid, { text: `Popular Movie AI Studio WhatsApp connection test · ${new Date().toISOString()}` });
        if (!result?.key.id) throw new Error('WhatsApp did not confirm acceptance');
        return result.key.id;
      },
      async sendNotification(notification) {
        const current = socket;
        if (stopped || !current?.user?.id) throw new Error('WhatsApp not connected');
        const jid = jidNormalizedUser(current.user.id);
        const caption = [
          `✅ 下载完成 · ${notification.title}`, notification.resourceName,
          `下载器: ${notification.provider} · ${(notification.totalBytes / 1024 ** 3).toFixed(2)} GiB`,
          `检测完成时间: ${notification.completedAt.toISOString()}`, notification.detailUrl,
        ].join('\n');
        const result = await current.sendMessage(jid, notification.poster ? { image: notification.poster, caption } : { text: caption });
        if (!result?.key.id) throw new Error('WhatsApp did not confirm acceptance');
        return result.key.id;
      },
      async stop(logout) {
        stopped = true;
        removeRefreshObserver?.();
        if (reconnect) clearTimeout(reconnect);
        if (logout && socket) {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([socket.logout().catch(() => undefined), new Promise<void>(resolve => { timeout = setTimeout(resolve, 5_000); })]);
          } finally { if (timeout) clearTimeout(timeout); }
        }
        socket?.end(undefined);
        await writes.catch(() => undefined);
      },
    };
  };
}
export const connectBaileys = createBaileysConnector();

function maskedAccount(jid?: string): string {
  if (!jid) return 'WhatsApp';
  const user = jidNormalizedUser(jid).split('@')[0] ?? '';
  return `••••${user.slice(-4)}`;
}

function disconnectReason(code?: number): NonNullable<WhatsAppConfiguration['failureReason']> {
  switch (code) {
    case DisconnectReason.loggedOut: return 'logged_out';
    case DisconnectReason.badSession: return 'bad_session';
    case DisconnectReason.connectionReplaced: return 'connection_replaced';
    case DisconnectReason.forbidden: return 'forbidden';
    case DisconnectReason.timedOut: return 'timeout';
    case DisconnectReason.connectionClosed: return 'connection_lost';
    default: return 'connection_error';
  }
}

// An allowlist keeps arbitrary errors (which may contain identities or secrets) out of logs.
function diagnosticReason(error: unknown): NonNullable<WhatsAppDiagnostic['reason']> {
  const message = error instanceof Error ? error.message
    : typeof error === 'object' && error !== null && 'message' in error ? error.message : undefined;
  switch (message) {
    case 'QR refs attempts ended': return 'qr_refs_exhausted';
    case 'Connection was lost': return 'connection_lost';
    case 'Timed Out': return 'operation_timeout';
    case 'Pre-key upload timeout': return 'prekey_upload_timeout';
    default: return 'unknown';
  }
}
