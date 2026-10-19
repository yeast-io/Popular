import { randomUUID } from 'node:crypto';
import type { WhatsAppConfiguration } from '@movie-hub/contract';
import type { AuthService } from '../auth/auth.service.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { WhatsAppConnection, WhatsAppConnector, WhatsAppDiagnostic, WhatsAppStore } from './whatsapp.types.js';
import type { IncomingMessage } from '../incoming-message.js';

type Session = {
  leaseId: string;
  state: WhatsAppConfiguration;
  connection?: WhatsAppConnection;
  heartbeat?: ReturnType<typeof setInterval>;
  deadline?: ReturnType<typeof setTimeout>;
  lastTestAt?: number;
  listeners?: Set<() => void>;
};
export class WhatsAppService {
  private readonly sessions = new Map<string, Session>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private closed = false;
  private readonly lastStates = new Map<string, WhatsAppConfiguration>();
  constructor(
    private readonly auth: Pick<AuthService, 'requireOwnerId'>,
    private readonly store: WhatsAppStore,
    private readonly connect: WhatsAppConnector,
    private readonly report: (ownerId: string, event: WhatsAppDiagnostic) => void = () => undefined,
    private readonly receive: (ownerId: string, message: IncomingMessage) => void | Promise<void> = () => {
      return undefined;
    }
  ) {}

  private async owned<T>(token: string | undefined, work: (ownerId: string) => Promise<T>): Promise<T> {
    const ownerId = await this.auth.requireOwnerId(token);
    return this.serial(ownerId, () => {
      if (this.closed) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'WhatsApp is shutting down');
      return work(ownerId);
    });
  }
  private async serial<T>(ownerId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(ownerId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.queues.set(ownerId, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(ownerId) === next) this.queues.delete(ownerId);
    }
  }
  get(token: string | undefined): Promise<WhatsAppConfiguration> {
    return this.owned(token, async (ownerId) => {
      const session = this.sessions.get(ownerId);
      if (session) return this.visible(session.state);
      const lastState = this.lastStates.get(ownerId);
      if (lastState) return this.visible(lastState);
      return { status: (await this.store.exists(ownerId)) ? 'disconnected' : 'unbound' };
    });
  }
  start(token: string | undefined): Promise<WhatsAppConfiguration> {
    return this.owned(token, (ownerId) => this.startOwner(ownerId));
  }
  private async startOwner(ownerId: string): Promise<WhatsAppConfiguration> {
    const existing = this.sessions.get(ownerId);
    if (existing && ['connecting', 'qr', 'pairing', 'connected'].includes(existing.state.status))
      return this.visible(existing.state);
    if (existing) await this.stop(ownerId, existing, false);
    const session: Session = { leaseId: randomUUID(), state: { status: 'connecting' } };
    if (!(await this.store.acquire(ownerId, session.leaseId)))
      throw new AppError(
        409,
        'CONFLICT',
        'WhatsApp session is active on another server. Retry on that server or after it stops.',
      );
    this.lastStates.delete(ownerId);
    this.sessions.set(ownerId, session);
    try {
      session.connection = await this.connect({
        receive: async (message) => {
          if (this.closed || this.sessions.get(ownerId) !== session) return;
          if (!(await this.store.renew(ownerId, session.leaseId))) return;
          if (!this.closed && this.sessions.get(ownerId) === session) await this.receive(ownerId, message);
        },
        report: (event) => this.report(ownerId, event),
        load: () => this.store.load(ownerId, session.leaseId),
        save: (state) => this.store.save(ownerId, session.leaseId, state),
        update: (state) => {
          if (this.sessions.get(ownerId) !== session) return;
          session.state = state;
          session.listeners?.forEach((listener) => listener());
          if (state.status === 'connected' && session.deadline) clearTimeout(session.deadline);
          if (state.status === 'error' || state.status === 'disconnected') {
            void this.serial(ownerId, async () => {
              if (this.sessions.get(ownerId) === session) await this.stop(ownerId, session, false);
            }).catch(
              () => undefined
            );
          }
        },
      });
      session.heartbeat = setInterval(() => {
        void this.serial(ownerId, async () => {
          if (this.sessions.get(ownerId) !== session) return;
          try {
            if (await this.store.renew(ownerId, session.leaseId)) return;
          } catch {
            /* fail closed */
          }
          session.state = { status: 'error', failureReason: 'lease_lost' };
          this.report(ownerId, { event: 'lease_lost' });
          await this.stop(ownerId, session, false);
        }).catch(
          () => undefined
        );
      }, 15_000);
      session.heartbeat.unref();
      session.deadline = setTimeout(() => {
        void this.serial(ownerId, async () => {
          if (this.sessions.get(ownerId) === session && session.state.status !== 'connected') {
            session.state = { status: 'disconnected', failureReason: 'timeout' };
            this.report(ownerId, { event: 'binding_timeout' });
            await this.stop(ownerId, session, false);
          }
        }).catch(
          () => undefined
        );
      }, 300_000);
      session.deadline.unref();
      return this.visible(session.state);
    } catch {
      await this.stop(ownerId, session, false);
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Could not start WhatsApp binding');
    }
  }
  async isConfigured(ownerId: string): Promise<boolean> {
    return this.store.exists(ownerId);
  }
  /** Restore saved linked accounts on startup without exposing an unauthenticated HTTP endpoint. */
  async resume(ownerIds: string[]): Promise<void> {
    for (const ownerId of ownerIds) {
      try {
        await this.serial(ownerId, () => this.startOwner(ownerId));
      } catch {
        this.report(ownerId, { event: 'connection_error' });
      }
    }
  }
  async canReply(ownerId: string, chatId: string): Promise<boolean> {
    if (!(await this.store.exists(ownerId))) return false;
    const session = this.sessions.get(ownerId);
    if (!session?.connection || session.state.status !== 'connected') throw new Error('WhatsApp unavailable');
    return session.connection.ownsChat?.(chatId) === true;
  }
  async setTyping(ownerId: string, chatId: string, active: boolean, signal?: AbortSignal): Promise<void> {
    return this.serial(ownerId, async () => {
      signal?.throwIfAborted();
      const session = this.sessions.get(ownerId);
      if (
        this.closed ||
        !session?.connection?.setTyping ||
        session.state.status !== 'connected' ||
        session.connection.ownsChat?.(chatId) !== true ||
        !(await this.store.renew(ownerId, session.leaseId))
      )
        throw new Error('WhatsApp unavailable');
      signal?.throwIfAborted();
      await session.connection.setTyping(active);
    });
  }
  async reply(ownerId: string, chatId: string, text: string, poster?: Buffer): Promise<string> {
    return this.serial(ownerId, async () => {
      const session = this.sessions.get(ownerId);
      if (
        this.closed ||
        !session?.connection?.sendReply ||
        session.state.status !== 'connected' ||
        session.connection.ownsChat?.(chatId) !== true ||
        !(await this.store.renew(ownerId, session.leaseId))
      )
        throw new Error('WhatsApp unavailable');
      return session.connection.sendReply(text, poster);
    });
  }
  async sendNotification(
    ownerId: string,
    notification: import('../notifications/notification.types.js').DownloadNotification,
  ): Promise<{ messageId: string }> {
    return this.serial(ownerId, async () => {
      if (this.closed || !(await this.store.exists(ownerId))) throw new Error('WhatsApp not linked');
      await this.startOwner(ownerId);
      const session = this.sessions.get(ownerId);
      if (!session?.connection) throw new Error('WhatsApp unavailable');
      if (!(await this.store.renew(ownerId, session.leaseId))) throw new Error('WhatsApp lease lost');
      if (session.state.status !== 'connected') {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error('WhatsApp connection timeout'));
          }, 20_000);
          const cleanup = () => {
            clearTimeout(timer);
            session.listeners?.delete(check);
          };
          const check = () => {
            if (session.state.status === 'connected') {
              cleanup();
              resolve();
            } else if (['error', 'disconnected', 'qr'].includes(session.state.status)) {
              cleanup();
              reject(new Error('WhatsApp reconnect failed'));
            }
          };
          (session.listeners ??= new Set()).add(check);
          check();
        });
      }
      if (!(await this.store.renew(ownerId, session.leaseId)) || !session.connection.sendNotification)
        throw new Error('WhatsApp unavailable');
      return { messageId: await session.connection.sendNotification(notification) };
    });
  }
  test(token: string | undefined): Promise<{ messageId: string }> {
    return this.owned(token, async (ownerId) => {
      const session = this.sessions.get(ownerId);
      if (!session?.connection || session.state.status !== 'connected')
        throw new AppError(409, 'CONFLICT', 'Connect WhatsApp first');
      if (session.lastTestAt && Date.now() - session.lastTestAt < 30_000)
        throw new AppError(409, 'CONFLICT', 'Wait 30 seconds before another test');
      if (!(await this.store.renew(ownerId, session.leaseId))) {
        await this.stop(ownerId, session, false);
        throw new AppError(409, 'CONFLICT', 'WhatsApp session lease lost');
      }
      session.lastTestAt = Date.now();
      try {
        return { messageId: await session.connection.sendSelf() };
      } catch {
        throw new AppError(
          502,
          'SERVICE_UNAVAILABLE',
          'Test delivery could not be confirmed. Check WhatsApp before retrying.',
        );
      }
    });
  }
  remove(token: string | undefined): Promise<void> {
    return this.owned(token, async (ownerId) => {
      let session = this.sessions.get(ownerId);
      if (session && !(await this.store.renew(ownerId, session.leaseId))) {
        await this.stop(ownerId, session, false);
        throw new AppError(409, 'CONFLICT', 'WhatsApp session lease lost');
      }
      if (!session) {
        session = { leaseId: randomUUID(), state: { status: 'unbound' } };
        if (!(await this.store.acquire(ownerId, session.leaseId)))
          throw new AppError(409, 'CONFLICT', 'WhatsApp session is active on another server');
      }
      await this.stop(ownerId, session, true);
    });
  }
  private visible(state: WhatsAppConfiguration): WhatsAppConfiguration {
    if (state.status === 'qr' && (!state.qrExpiresAt || Date.parse(state.qrExpiresAt) <= Date.now()))
      return { status: 'connecting' };
    return { ...state };
  }
  private async stop(ownerId: string, session: Session, logout: boolean): Promise<void> {
    this.sessions.delete(ownerId);
    if (logout) this.lastStates.delete(ownerId);
    else if (session.state.status === 'error' || session.state.status === 'disconnected')
      this.lastStates.set(ownerId, { ...session.state });
    if (session.heartbeat) clearInterval(session.heartbeat);
    if (session.deadline) clearTimeout(session.deadline);
    try {
      await session.connection?.stop(logout);
      if (logout) await this.store.clear(ownerId, session.leaseId);
    } finally {
      await this.store.release(ownerId, session.leaseId);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.queues.values()]);
    await Promise.allSettled(
      [...this.sessions].map(([ownerId, session]) => {
        return this.stop(ownerId, session, false);
      }),
    );
    this.lastStates.clear();
  }
}
