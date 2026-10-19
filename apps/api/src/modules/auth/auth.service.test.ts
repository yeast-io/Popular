import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../../infrastructure/http/app-error.js';
import { AuthService } from './auth.service.js';
import { DuplicateEmailError } from './auth.errors.js';
import type { AuthUserStore, SessionStore, StoredUser } from './auth.types.js';

class MemoryUsers implements AuthUserStore {
  readonly users = new Map<string, StoredUser>();
  async countUsers() {
    return this.users.size;
  }
  async createPasswordUser(input: Omit<StoredUser, 'id'>): Promise<StoredUser> {
    if (this.users.has(input.email)) throw new DuplicateEmailError();
    const user = { ...input, id: String(this.users.size + 1) };
    this.users.set(user.email, user);
    return user;
  }
  async findByEmailWithPassword(email: string) {
    return this.users.get(email) ?? null;
  }
  async findById(id: string) {
    return (
      [...this.users.values()].find((user) => {
        return user.id === id;
      }) ?? null
    );
  }
  async updateDisplayName(id: string, displayName: string) {
    const user = await this.findById(id);
    if (!user) return null;
    user.displayName = displayName;
    return user;
  }
  async updateAvatarObjectKey(id: string, avatarObjectKey: string | undefined) {
    const user = await this.findById(id);
    if (!user) return null;
    if (avatarObjectKey) user.avatarObjectKey = avatarObjectKey;
    else delete user.avatarObjectKey;
    return user;
  }
}

class MemorySessions implements SessionStore {
  readonly sessions = new Map<string, string>();
  async create(ownerId: string) {
    const token = `token-${ownerId}-${this.sessions.size}`;
    this.sessions.set(token, ownerId);
    return token;
  }
  async getOwnerId(token: string) {
    return this.sessions.get(token) ?? null;
  }
  async delete(token: string) {
    this.sessions.delete(token);
  }
}

test('register normalizes email and creates an authenticated session', async () => {
  const users = new MemoryUsers();
  const sessions = new MemorySessions();
  const service = new AuthService(users, sessions, 100);
  const result = await service.register({
    email: ' PERSON@Example.COM ',
    password: 'correct horse battery staple',
    displayName: 'Person',
  }
  );
  assert.equal(result.user.email, 'person@example.com');
  assert.equal(await sessions.getOwnerId(result.token), result.user.id);
  assert.notEqual(users.users.get('person@example.com')?.passwordHash, 'correct horse battery staple');
});

test('register rejects new users once the configured limit is reached', async () => {
  const users = new MemoryUsers();
  const service = new AuthService(users, new MemorySessions(), 1);
  await service.register({
    email: 'first@example.com',
    password: 'correct horse battery staple',
    displayName: 'First',
  }
  );
  await assert.rejects(
    service.register({ email: 'second@example.com', password: 'correct horse battery staple', displayName: 'Second' }),
    (error: unknown) => {
      return (
        error instanceof AppError &&
        error.statusCode === 403 &&
        error.code === 'REGISTRATION_LIMIT_REACHED' &&
        error.message === 'Registration user limit has been reached'
      );
    },
  );
  assert.equal(users.users.size, 1);
});

test('concurrent registrations cannot exceed the configured limit in one server process', async () => {
  const users = new MemoryUsers();
  const service = new AuthService(users, new MemorySessions(), 1);
  const results = await Promise.allSettled([
    service.register({ email: 'first@example.com', password: 'correct horse battery staple', displayName: 'First' }),
    service.register({ email: 'second@example.com', password: 'correct horse battery staple', displayName: 'Second' }),
  ]
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(users.users.size, 1);
});

test('login rejects a wrong password without revealing which credential failed', async () => {
  const service = new AuthService(new MemoryUsers(), new MemorySessions(), 100);
  await assert.rejects(
    service.login({ email: 'missing@example.com', password: 'incorrect password' }),
    (error: unknown) => {
      return error instanceof AppError && error.statusCode === 401 && error.message === 'Invalid email or password';
    },
  );
});

test('current user and logout use the server-side session', async () => {
  const users = new MemoryUsers();
  const sessions = new MemorySessions();
  const service = new AuthService(users, sessions, 100);
  const registered = await service.register({
    email: 'person@example.com',
    password: 'correct horse battery staple',
    displayName: 'Person',
  }
  );
  assert.equal((await service.currentUser(registered.token)).id, registered.user.id);
  await service.logout(registered.token);
  await assert.rejects(
    service.currentUser(registered.token),
    (error: unknown) => error instanceof AppError && error.statusCode === 401,
  );
});
