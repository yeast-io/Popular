// Only selected message fields reach application logs; never log transport payloads.
export interface IncomingMessage {
  channel: 'telegram' | 'whatsapp';
  senderId: string;
  chatId: string;
  messageId?: string;
  messageType: string;
  text?: string;
  /** Set by the WhatsApp adapter only after checking the linked account identity. */
  isSelfChat?: boolean;
}
