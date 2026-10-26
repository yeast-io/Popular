import type { EmailVerificationStore, PendingRegistration, VerificationReservation } from './email-verification.types.js';
import type { AuthUserStore } from './auth.types.js';
import { EmailVerificationService } from './email-verification.service.js';

export function verificationFixture(users: AuthUserStore, limit = 100) {
  const records = new Map<string, { digest: string; registration: PendingRegistration; reservationId: string; attempts: number; claim?: string }>();
  const sent: { email: string; code: string; locale: string }[] = [];
  let attempts = 0;
  let failSend = false;
  const store: EmailVerificationStore = {
    async reserve(key, digest, reservationId, registration): Promise<VerificationReservation> {
      const existing = records.get(key);
      if (existing && existing.registration.expiresAt > Date.now()) return { status: 'existing', expiresAt: existing.registration.expiresAt };
      if (attempts >= 100) return { status: 'limit', expiresAt: 0 };
      attempts++;
      records.set(key, { digest, registration, reservationId, attempts: 0 });
      return { status: 'created', expiresAt: registration.expiresAt };
    },
    async claim(key, digest, claim) {
      const record = records.get(key);
      if (!record || record.registration.expiresAt <= Date.now() || record.claim || record.attempts >= 5) return null;
      if (record.digest !== digest) {
        record.attempts++;
        return null;
      }
      record.claim = claim;
      return record.registration;
    },
    async finish(key, claim, remove) {
      const record = records.get(key);
      if (record?.claim !== claim) return;
      if (remove) records.delete(key);
      else delete record.claim;
    },
    async cancel(key, reservationId) {
      if (records.get(key)?.reservationId === reservationId) records.delete(key);
    },
  };
  const service = new EmailVerificationService(users, store, {
    async send(email, code, locale) {
      if (failSend) throw new Error('Simulated Mailgun failure');
      sent.push({ email, code, locale });
    },
  }, 'test-email-pepper-at-least-32-characters', limit);
  return { service, sent, records, exhaustQuota: () => {
    attempts = 100;
  }, failSend: () => {
    failSend = true;
  } };
}
