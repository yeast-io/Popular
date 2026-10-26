import type { Locale } from '@movie-hub/contract';

export interface PendingRegistration {
  email: string;
  displayName: string;
  passwordHash: string;
  locale: Locale;
  expiresAt: number;
}

export interface VerificationReservation {
  status: 'created' | 'existing' | 'limit';
  expiresAt: number;
}

export interface EmailVerificationStore {
  reserve(emailKey: string, codeDigest: string, reservationId: string, registration: PendingRegistration): Promise<VerificationReservation>;
  claim(emailKey: string, codeDigest: string, claimId: string): Promise<PendingRegistration | null>;
  finish(emailKey: string, claimId: string, remove: boolean): Promise<void>;
  cancel(emailKey: string, reservationId: string): Promise<void>;
}

export interface VerificationEmailSender {
  send(email: string, code: string, locale: Locale): Promise<void>;
}
