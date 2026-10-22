import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Session, WireMessage } from './gateway.types.js';

export const keyDigest = (key: string) => createHash('sha256').update(key).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{'
      + Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',')
        + '}'
    );
  }
  return JSON.stringify(value);
}
export const fingerprint = (value: unknown) => keyDigest(canonical(value));
export function sameSession(a: Session, b: Session): boolean {
  return (
    a.ownerId === b.ownerId
    && a.deviceId === b.deviceId
    && a.authVersion === b.authVersion
    && a.deviceVersion === b.deviceVersion
    && a.sessionId === b.sessionId
    && a.instanceId === b.instanceId
  );
}
export function equalSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
export function message(command: string, payload: unknown, reply?: WireMessage, correlationId?: string): WireMessage {
  return {
    protocolVersion: 1,
    command,
    messageId: randomUUID(),
    payload,
    ...(reply ? { replyTo: reply.messageId } : {}),
    ...(correlationId || reply?.correlationId ? { correlationId: correlationId ?? reply!.correlationId! } : {}),
  };
}
