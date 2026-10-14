import type { AuthUser, LoginRequest, RegisterRequest } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import { hashPassword, verifyPassword } from './password.js';
import { DuplicateEmailError, type AuthUserStore, type SessionStore, type StoredUser } from './auth.types.js';

const DUMMY_PASSWORD_HASH = `scrypt$AAAAAAAAAAAAAAAAAAAAAA$${Buffer.alloc(64).toString('base64url')}`;

export class AuthService {
  private registrationQueue = Promise.resolve();

  constructor(
    private readonly users: AuthUserStore,
    private readonly sessions: SessionStore,
    private readonly registrationUserLimit: number,
  ) {}

  async register(input: RegisterRequest): Promise<{ user: AuthUser; token: string }> {
    const email = normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    return this.withRegistrationLock(async () => {
      if (await this.users.countUsers() >= this.registrationUserLimit) {
        throw new AppError(403, 'REGISTRATION_LIMIT_REACHED', 'Registration user limit has been reached');
      }
      return this.createRegisteredUser(input, email, passwordHash);
    });
  }

  private async createRegisteredUser(
    input: RegisterRequest,
    email: string,
    passwordHash: string,
  ): Promise<{ user: AuthUser; token: string }> {
    try {
      const user = await this.users.createPasswordUser({
        email,
        displayName: input.displayName.trim(),
        passwordHash,
      });
      return { user: toAuthUser(user), token: await this.sessions.create(user.id) };
    } catch (error) {
      if (error instanceof DuplicateEmailError) {
        throw new AppError(409, 'CONFLICT', 'Email is already registered');
      }
      throw error;
    }
  }

  private async withRegistrationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.registrationQueue;
    let release!: () => void;
    this.registrationQueue = new Promise<void>((resolve) => { release = resolve; });
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
    ...(user.avatarObjectKey ? { avatarUrl: `/api/v1/users/me/avatar?v=${encodeURIComponent(user.avatarObjectKey)}` } : {}),
  };
}

function unauthorized(): AppError {
  return new AppError(401, 'UNAUTHORIZED', 'Authentication required');
}
