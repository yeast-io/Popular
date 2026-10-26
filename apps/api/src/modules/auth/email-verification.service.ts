import { createHmac, randomInt, randomUUID } from 'node:crypto';
import type { Locale, RegisterRequest, RegistrationPendingResponse, VerifyRegistrationRequest } from '@movie-hub/contract';
import type { AuthUserStore, StoredUser } from './auth.types.js';
import type { EmailVerificationStore, VerificationEmailSender } from './email-verification.types.js';
import { hashPassword, verifyPassword } from './password.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { aiStep } from '../../infrastructure/logging/ai-trace.js';
import { emailVerificationPolicy } from './email-verification.policy.js';
import { emailVerificationMessages } from './email-verification.messages.js';
import { DuplicateEmailError } from './auth.errors.js';

export class EmailVerificationService {
  constructor(
    private readonly users: AuthUserStore,
    private readonly store: EmailVerificationStore,
    private readonly sender: VerificationEmailSender,
    private readonly pepper: string,
    private readonly userLimit: number
  ) {}

  async start(input: RegisterRequest, locale: Locale): Promise<RegistrationPendingResponse> {
    const email = input.email.trim().toLowerCase();
    const copy = emailVerificationMessages[locale];
    if (await aiStep('registration.user.lookup', () => this.users.findByEmailWithPassword(email))) {
      throw new AppError(409, 'CONFLICT', copy.conflict);
    }
    if (await this.users.countUsers() >= this.userLimit) throw new AppError(403, 'REGISTRATION_LIMIT_REACHED', copy.userLimit);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const emailKey = this.digest('email', email);
    const reservationId = randomUUID();
    const registration = {
      email, displayName: input.displayName.trim(), passwordHash: await hashPassword(input.password), locale,
      expiresAt: Date.now() + emailVerificationPolicy.ttlSeconds * 1000,
    };
    const reservation = await aiStep('registration.verification.reserve', () => {
      return this.store.reserve(emailKey, this.digest(email, code), reservationId, registration);
    });
    if (reservation.status === 'limit') throw new AppError(429, 'EMAIL_VERIFICATION_LIMIT_REACHED', copy.limit);
    if (reservation.status === 'created') {
      try {
        await aiStep('registration.email.send', () => this.sender.send(email, code, locale));
      } catch (error) {
        try {
          await this.store.cancel(emailKey, reservationId);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Verification email failed and pending registration cleanup failed', { cause: cleanupError });
        }
        throw new AppError(503, 'EMAIL_VERIFICATION_UNAVAILABLE', copy.unavailable, undefined, { cause: error });
      }
    }
    return { email, expiresAt: new Date(reservation.expiresAt).toISOString() };
  }

  async verify(input: VerifyRegistrationRequest, locale: Locale): Promise<StoredUser> {
    const email = input.email.trim().toLowerCase();
    const emailKey = this.digest('email', email);
    const claimId = randomUUID();
    const copy = emailVerificationMessages[locale];
    const pending = await aiStep('registration.verification.claim', () => this.store.claim(emailKey, this.digest(email, input.code), claimId));
    if (!pending) throw new AppError(400, 'EMAIL_VERIFICATION_INVALID', copy.invalid);
    let created = false;
    try {
      // Bind verification to the submitted registration credentials as well as email.
      // Otherwise a pre-registered email could activate an attacker's chosen password.
      if (!await verifyPassword(input.password, pending.passwordHash)) {
        throw new AppError(400, 'EMAIL_VERIFICATION_INVALID', copy.invalid);
      }
      const existing = await this.users.findByEmailWithPassword(email);
      // Recover a completed Mongo write if Redis cleanup failed after account creation.
      if (existing && existing.passwordHash !== pending.passwordHash) throw new AppError(409, 'CONFLICT', copy.conflict);
      if (!existing && await this.users.countUsers() >= this.userLimit) {
        throw new AppError(403, 'REGISTRATION_LIMIT_REACHED', copy.userLimit);
      }
      const user = existing ?? await aiStep('registration.user.create', () => this.users.createPasswordUser(pending));
      created = true;
      await aiStep('registration.verification.consume', () => this.store.finish(emailKey, claimId, true));
      return user;
    } catch (error) {
      if (!created) {
        try {
          await this.store.finish(emailKey, claimId, false);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Registration verification and claim cleanup failed', { cause: cleanupError });
        }
      }
      if (error instanceof DuplicateEmailError) throw new AppError(409, 'CONFLICT', copy.conflict);
      throw error;
    }
  }

  private digest(context: string, value: string): string {
    return createHmac('sha256', this.pepper).update(`${context}\0${value}`).digest('hex');
  }
}
