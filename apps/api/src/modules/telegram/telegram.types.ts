

export interface TelegramRecord {
  chatId?: string;
  account?: string;
  expiresAt?: Date;
}

export interface TelegramStore {
  find(ownerId: string): Promise<TelegramRecord | null>;
  findOwnerByChatId(chatId: string): Promise<string | null>;
  pending(ownerId: string, hash: string, expiresAt: Date): Promise<boolean>;
  consume(hash: string, chatId: string, account: string, now: Date): Promise<boolean>;
  remove(ownerId: string): Promise<void>;
  reserveTest(ownerId: string, chatId: string, now: Date): Promise<boolean>;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    text?: string;
    caption?: string;
    photo?: unknown[];
    video?: unknown;
    audio?: unknown;
    voice?: unknown;
    document?: unknown;
    sticker?: unknown;
    from?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
    chat: { id: number; type: string };
  };
}

export interface TelegramTransport {
  username(): Promise<string>;
  send(chatId: string, text: string, parseMode?: 'HTML'): Promise<string>;
  sendPhoto(chatId: string, photo: Buffer, caption: string): Promise<string>;
  typing?(chatId: string, signal?: AbortSignal): Promise<void>;
  updates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
}
