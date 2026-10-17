import { AppError } from '../http/app-error.js';
import type { TelegramTransport, TelegramUpdate } from '../../modules/telegram/telegram.service.js';
export class TelegramClient implements TelegramTransport {
  private botUsername?: string;
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}
  private async call<T>(method: string, payload: object | FormData): Promise<T> {
    // Never propagate fetch errors: their messages/causes may include the token-bearing URL.
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', ...(payload instanceof FormData
          ? { body: payload }
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json() as { ok?: boolean; result?: T };
      if (!response.ok || body.ok !== true || body.result === undefined) throw new Error('rejected');
      return body.result;
    } catch { throw new AppError(502, 'SERVICE_UNAVAILABLE', 'Telegram request failed; check Bot configuration, connectivity, or whether the Bot is blocked'); }
  }
  async username(): Promise<string> {
    if (!this.botUsername) {
      const result = await this.call<{ username?: string; is_bot?: boolean }>('getMe', {});
      if (!result.is_bot || !result.username || !/^[A-Za-z0-9_]+$/.test(result.username)) throw new AppError(502, 'SERVICE_UNAVAILABLE', 'Invalid Telegram bot identity');
      this.botUsername = result.username;
    }
    return this.botUsername;
  }
  async send(chatId: string, text: string, parseMode?: 'HTML'): Promise<string> {
    const result = await this.call<{ message_id: number }>('sendMessage', { chat_id: chatId, text, ...(parseMode ? { parse_mode: parseMode } : {}), link_preview_options: { is_disabled: true } });
    if (!Number.isSafeInteger(result.message_id)) throw new AppError(502, 'SERVICE_UNAVAILABLE', 'Invalid Telegram response');
    return String(result.message_id);
  }
  async sendPhoto(chatId: string, photo: Buffer, caption: string): Promise<string> {
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('photo', new Blob([new Uint8Array(photo)]), 'poster');
    form.set('caption', caption);
    form.set('parse_mode', 'HTML');
    const result = await this.call<{ message_id: number }>('sendPhoto', form);
    if (!Number.isSafeInteger(result.message_id)) throw new AppError(502, 'SERVICE_UNAVAILABLE', 'Invalid Telegram response');
    return String(result.message_id);
  }
  async updates(offset: number): Promise<TelegramUpdate[]> {
    const result = await this.call<TelegramUpdate[]>('getUpdates', { offset, timeout: 5, limit: 25, allowed_updates: ['message'] });
    if (!Array.isArray(result) || result.some(item => !Number.isSafeInteger(item.update_id) || item.update_id < 0)) throw new AppError(502, 'SERVICE_UNAVAILABLE', 'Invalid Telegram updates');
    return result;
  }
}
