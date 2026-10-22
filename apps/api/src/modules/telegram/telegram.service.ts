import type { TelegramStore, TelegramUpdate, TelegramTransport } from './telegram.types.js';
import { AiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import { createHash, randomBytes } from 'node:crypto';
import type { TelegramBinding, TelegramConfiguration } from '@movie-hub/contract';
import type { AuthService } from '../auth/auth.service.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { DownloadNotification } from '../notifications/notification.types.js';
import type { IncomingMessage } from '../incoming-message.types.js';

export const bindingHash = (value: string): string => {
  return createHash('sha256').update(value).digest('hex');
};
export class TelegramService {
  constructor(
    private readonly auth: Pick<AuthService, 'requireOwnerId'>,
    private readonly store: TelegramStore,
    private readonly transport?: TelegramTransport,
    private readonly now: () => Date = () => new Date(),
    private readonly receive: (ownerId: string, message: IncomingMessage) => void | Promise<void> = () => {
      return undefined;
    },
    private readonly logger?: AiLogger
  ) {}

  async get(token: string | undefined): Promise<TelegramConfiguration> {
    const owner = await this.auth.requireOwnerId(token);
    if (!this.transport) return { status: 'unavailable' };
    const record = await this.store.find(owner);
    if (record?.chatId) return { status: 'connected', account: record.account ?? record.chatId };
    if (record?.expiresAt && record.expiresAt > this.now())
      return { status: 'pending', expiresAt: record.expiresAt.toISOString() };
    return { status: 'unbound' };
  }

  async start(token: string | undefined): Promise<TelegramBinding> {
    const owner = await this.auth.requireOwnerId(token);
    if (!this.transport) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Telegram is not configured');
    const username = await this.transport.username();
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + 600_000);
    if (!(await this.store.pending(owner, bindingHash(secret), expiresAt)))
      throw new AppError(409, 'CONFLICT', 'Unlink Telegram before replacing it');
    return {
      status: 'pending',
      expiresAt: expiresAt.toISOString(),
      bindingUrl: `https://t.me/${username}?start=${secret}`,
    };
  }

  async accept(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const trace = new AiTrace(
      this.logger,
      {
        event: 'telegram_message',
        channel: 'telegram',
        updateId: update.update_id,
        messageId: message?.message_id,
        chatId: message?.chat.id,
      },
      message?.text ?? message?.caption ?? '',
      'telegram.receive'
    );
    trace.sensitive((message?.text ?? message?.caption ?? '').trim());
    await withAiTrace(trace, async () => {
      const skip = (reason: string) => trace.event('telegram.message.filtered', { reason });
      if (!message) return skip('no_message');
      if (message.chat.type !== 'private') return skip('not_private_chat');
      if (!message.from) return skip('missing_sender');
      if (message.from.is_bot) return skip('bot_sender');
      if (message.from.id !== message.chat.id) return skip('sender_chat_mismatch');
      if (!Number.isSafeInteger(message.chat.id) || message.chat.id <= 0) return skip('invalid_chat_id');
      const match = /^\/start(?:@[A-Za-z0-9_]+)? ([A-Za-z0-9_-]{43})$/.exec(message.text ?? '');
      if (!match) {
        if (/^\/start(?:@\S+)?(?:\s|$)/.test(message.text ?? '')) return skip('binding_command');
        const chatId = String(message.chat.id);
        const ownerId = await trace.step('telegram.binding.lookup', () => this.store.findOwnerByChatId(chatId));
        if (!ownerId) return skip('chat_not_bound');
        const messageType
          = message.text !== undefined
            ? 'text'
            : (['photo', 'video', 'audio', 'voice', 'document', 'sticker'].find(
                (key) => message[key as keyof typeof message] != null
              ) ?? 'unknown');
        const text = message.text ?? message.caption;
        trace.event('telegram.message.accepted', { ownerId, messageType });
        await trace.step(
          'telegram.message.dispatch',
          () => {
            return Promise.resolve(
              this.receive(ownerId, {
                channel: 'telegram',
                senderId: String(message.from!.id),
                chatId,
                messageType,
                ...(message.message_id !== undefined ? { messageId: String(message.message_id) } : {}),
                ...(text !== undefined ? { text } : {}),
              }
              )
            );
          },
          { ownerId }
        );
        return;
      }
      trace.sensitive(match[1]!);
      // Binding tokens and user text are never included in diagnostic fields.
      const consumed = await trace.step('telegram.binding.consume', () => {
        return this.store.consume(
          bindingHash(match[1]!),
          String(message.chat.id),
          message.from!.username
            ? `@${message.from!.username}`
            : (message.from!.first_name ?? String(message.chat.id)).slice(0, 100),
          this.now()
        );
      });
      trace.event('telegram.binding.result', { consumed });
    }).catch((error) => {
      trace.fail(error);
      throw error;
    });
  }

  async remove(token: string | undefined): Promise<void> {
    await this.store.remove(await this.auth.requireOwnerId(token));
  }

  async canReply(ownerId: string, chatId: string): Promise<boolean> {
    return !!this.transport && (await this.store.find(ownerId))?.chatId === chatId;
  }

  async setTyping(ownerId: string, chatId: string, active: boolean, signal?: AbortSignal): Promise<void> {
    // Telegram clears typing on reply or expiry; Bot API has no explicit stop action.
    if (!active) return;
    signal?.throwIfAborted();
    if (!(await this.canReply(ownerId, chatId))) throw new AppError(409, 'CONFLICT', 'Telegram binding changed');
    signal?.throwIfAborted();
    await this.transport?.typing?.(chatId, signal);
  }

  async reply(ownerId: string, chatId: string, text: string, poster?: Buffer): Promise<string> {
    if (!(await this.canReply(ownerId, chatId))) throw new AppError(409, 'CONFLICT', 'Telegram binding changed');
    return poster?.length
      ? this.transport!.sendPhoto(chatId, poster, escapeHtml(text))
      : this.transport!.send(chatId, text);
  }

  async test(token: string | undefined): Promise<{ messageId: string }> {
    const owner = await this.auth.requireOwnerId(token);
    const chatId = await this.recipient(owner);
    if (!(await this.store.reserveTest(owner, chatId, this.now())))
      throw new AppError(409, 'CONFLICT', 'Wait 30 seconds before testing again');
    return { messageId: await this.transport!.send(chatId, 'Popular: Telegram notification test / Telegram 通知测试') };
  }

  async isConfigured(ownerId: string): Promise<boolean> {
    return !!this.transport && !!(await this.store.find(ownerId))?.chatId;
  }

  private async recipient(ownerId: string): Promise<string> {
    if (!this.transport) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Telegram is not configured');
    const chatId = (await this.store.find(ownerId))?.chatId;
    if (!chatId) throw new AppError(409, 'CONFLICT', 'Link your Telegram account first');
    return chatId;
  }

  async sendNotification(ownerId: string, notification: DownloadNotification): Promise<{ messageId: string }> {
    const chatId = await this.recipient(ownerId);
    const caption = downloadCaption(notification);
    const messageId = notification.poster?.length
      ? await this.transport!.sendPhoto(chatId, notification.poster, caption)
      : await this.transport!.send(chatId, caption, 'HTML');
    return { messageId };
  }
}

const escapeHtml = (value: string): string => {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(
      /'/g, '&#39;'
    );
};
// Bound unescaped UTF-16 length before encoding so captions stay below Telegram's 1024-character limit,
// including emoji, and never cut HTML tags or entities in half.
function field(value: string, limit: number): string {
  if (value.length <= limit) return escapeHtml(value);
  let shortened = value.slice(0, limit - 1);
  if (/[\uD800-\uDBFF]$/.test(shortened)) shortened = shortened.slice(0, -1);
  return escapeHtml(shortened + '…');
}
function downloadCaption(notification: DownloadNotification): string {
  const lines = [
    '<b>✅ 下载完成 / Download complete</b>',
    `<b>${field(notification.title, 180)}</b>`,
    `<code>${field(notification.resourceName, 400)}</code>`,
    `${field(notification.provider, 40)} · ${(notification.totalBytes / 1024 ** 3).toFixed(2)} GiB`,
    notification.completedAt.toISOString(),
  ];
  try {
    const url = new URL(notification.detailUrl);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password)
      lines.push(`<a href="${escapeHtml(url.href)}">查看详情 / View details</a>`);
  } catch {
    /* An invalid detail link must not prevent delivery of the notification. */
  }
  return lines.join('\n');
}
