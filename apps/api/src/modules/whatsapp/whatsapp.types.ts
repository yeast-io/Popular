

import type { DownloadNotification } from '../notifications/notification.types.js';
import type { WhatsAppConfiguration } from '@movie-hub/contract';
import type { IncomingMessage } from '../incoming-message.types.js';

// Every operation, including lease checks, is scoped to the authenticated owner.
export interface WhatsAppStore {
  exists(ownerId: string): Promise<boolean>;
  acquire(ownerId: string, leaseId: string): Promise<boolean>;
  renew(ownerId: string, leaseId: string): Promise<boolean>;
  release(ownerId: string, leaseId: string): Promise<void>;
  load(ownerId: string, leaseId: string): Promise<string | null>;
  save(ownerId: string, leaseId: string, state: string): Promise<void>;
  clear(ownerId: string, leaseId: string): Promise<void>;
}
export interface WhatsAppConnection {
  /** Only replies to the linked account itself; no arbitrary recipient is accepted. */
  sendReply?(text: string, poster?: Buffer): Promise<string>;
  setTyping?(active: boolean): Promise<void>;
  ownsChat?(chatId: string): boolean;
  sendSelf(): Promise<string>;
  sendNotification(
    notification: DownloadNotification,
  ): Promise<string>;
  stop(logout: boolean): Promise<void>;
}
export interface WhatsAppDiagnostic {
  event:
    | 'connecting'
    | 'qr_issued'
    | 'pairing_accepted'
    | 'connected'
    | 'disconnected'
    | 'reconnect_scheduled'
    | 'storage_error'
    | 'connection_error'
    | 'lease_lost'
    | 'binding_timeout'
    | 'registration_refresh_received'
    | 'message_receive_error';
  reason?: 'qr_refs_exhausted' | 'connection_lost' | 'operation_timeout' | 'prekey_upload_timeout' | 'unknown';
  elapsedMs?: number;
  qrCount?: number;
  paired?: boolean;
  code?: number;
  attempt?: number;
}
export interface WhatsAppConnectionOptions {
  receive?(message: IncomingMessage): Promise<void>;
  report?(event: WhatsAppDiagnostic): void;
  load(): Promise<string | null>;
  save(state: string): Promise<void>;
  update(state: WhatsAppConfiguration): void;
}
export type WhatsAppConnector = (options: WhatsAppConnectionOptions) => Promise<WhatsAppConnection>;

export type Session = {
  leaseId: string;
  state: WhatsAppConfiguration;
  connection?: WhatsAppConnection;
  heartbeat?: ReturnType<typeof setInterval>;
  deadline?: ReturnType<typeof setTimeout>;
  lastTestAt?: number;
  listeners?: Set<() => void>;
};
