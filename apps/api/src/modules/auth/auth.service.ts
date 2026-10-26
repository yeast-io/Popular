import { aiStep } from '../../infrastructure/logging/ai-trace.js';
import type { AuthUser, Locale, LoginRequest, RegisterRequest, RegistrationPendingResponse, VerifyRegistrationRequest } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import { verifyPassword } from './password.js';
import type { EmailVerificationService } from './email-verification.service.js';
import { emailVerificationMessages } from './email-verification.messages.js';
import type { AuthUserStore, SessionStore, StoredUser } from './auth.types.js';

const DUMMY_PASSWORD_HASH = `scrypt$AAAAAAAAAAAAAAAAAAAAAA$${Buffer.alloc(64).toString('base64url')}`;

export class AuthService {
  private registrationQueue = Promise.resolve();

  constructor(
    private readonly users: AuthUserStore,
    private readonly sessions: SessionStore,
    private readonly registrationUserLimit: number,
    private readonly verification?: EmailVerificationService
  ) {}

  async register(input: RegisterRequest, locale: Locale = 'zh-CN'): Promise<RegistrationPendingResponse> {
    if (!this.verification) throw new AppError(503, 'EMAIL_VERIFICATION_UNAVAILABLE', emailVerificationMessages[locale].unavailable);
    return this.verification.start(input, locale);
  }

  async verifyRegistration(input: VerifyRegistrationRequest, locale: Locale = 'zh-CN'): Promise<{ user: AuthUser; token: string }> {
    if (!this.verification) throw new AppError(503, 'EMAIL_VERIFICATION_UNAVAILABLE', emailVerificationMessages[locale].unavailable);
    return this.withRegistrationLock(async () => {
      const user = await this.verification!.verify(input, locale);
      return { user: toAuthUser(user), token: await this.sessions.create(user.id) };
    });
  }

  private async withRegistrationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.registrationQueue;
    let release!: () => void;
    this.registrationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async login(input: LoginRequest): Promise<{ user: AuthUser; token: string }> {
    const user = await this.users.findByEmailWithPassword(normalizeEmail(input.email));
    const valid = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !valid) throw new AppError(401, 'UNAUTHORIZED', 'Invalid email or password');
    return { user: toAuthUser(user), token: await this.sessions.create(user.id) };
  }

  async currentUser(token: string | undefined): Promise<AuthUser> {
    const ownerId = await this.requireOwnerId(token);
    const user = await this.users.findById(ownerId);
    if (!user) {
      if (token) await this.sessions.delete(token);
      throw unauthorized();
    }
    return toAuthUser(user);
  }

  async requireOwnerId(token: string | undefined): Promise<string> {
    if (!token) throw unauthorized();
    const ownerId = await this.sessions.getOwnerId(token);
    if (!ownerId) throw unauthorized();
    return ownerId;
  }

  async optionalOwnerId(token: string | undefined): Promise<string | null> {
    return token ? this.sessions.getOwnerId(token) : null;
  }

  async localeForOwner(ownerId: string, fallback: Locale): Promise<Locale> {
    const user = await aiStep('user.locale.read', () => this.users.findById(ownerId));
    return user?.locale ?? fallback;
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.sessions.delete(token);
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toAuthUser(user: StoredUser): AuthUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    ...(user.locale ? { locale: user.locale } : {}),
    ...(user.avatarObjectKey
      ? { avatarUrl: `/api/v1/users/me/avatar?v=${encodeURIComponent(user.avatarObjectKey)}` }
      : {}),
  };
}

function unauthorized(): AppError {
  return new AppError(401, 'UNAUTHORIZED', 'Authentication required');
}
