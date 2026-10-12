import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../../infrastructure/http/app-error.js';
import { AuthService } from './auth.service.js';
import { DuplicateEmailError, type AuthUserStore, type SessionStore, type StoredUser } from './auth.types.js';

class MemoryUsers implements AuthUserStore {
  readonly users = new Map<string, StoredUser>();
  async createPasswordUser(input: Omit<StoredUser, 'id'>): Promise<StoredUser> {
    if (this.users.has(input.email)) throw new DuplicateEmailError();
    const user = { ...input, id: String(this.users.size + 1) };
    this.users.set(user.email, user);
    return user;
  }
  async findByEmailWithPassword(email: string) { return this.users.get(email) ?? null; }
  async findById(id: string) { return [...this.users.values()].find((user) => user.id === id) ?? null; }
  async updateDisplayName(id: string, displayName: string) {
    const user = await this.findById(id); if (!user) return null; user.displayName = displayName; return user;
  }
  async updateAvatarObjectKey(id: string, avatarObjectKey: string | undefined) {
    const user = await this.findById(id); if (!user) return null;
    if (avatarObjectKey) user.avatarObjectKey = avatarObjectKey; else delete user.avatarObjectKey;
    return user;
  }
}

class MemorySessions implements SessionStore {
  readonly sessions = new Map<string, string>();
  async create(ownerId: string) { const token = `token-${ownerId}-${this.sessions.size}`; this.sessions.set(token, ownerId); return token; }
  async getOwnerId(token: string) { return this.sessions.get(token) ?? null; }
  async delete(token: string) { this.sessions.delete(token); }
}

test('register normalizes email and creates an authenticated session', async () => {
  const users = new MemoryUsers();
  const sessions = new MemorySessions();
  const service = new AuthService(users, sessions);
  const result = await service.register({ email: ' PERSON@Example.COM ', password: 'correct horse battery staple', displayName: 'Person' });
  assert.equal(result.user.email, 'person@example.com');
  assert.equal(await sessions.getOwnerId(result.token), result.user.id);
  assert.notEqual(users.users.get('person@example.com')?.passwordHash, 'correct horse battery staple');
});

test('login rejects a wrong password without revealing which credential failed', async () => {
  const service = new AuthService(new MemoryUsers(), new MemorySessions());
  await assert.rejects(
    service.login({ email: 'missing@example.com', password: 'incorrect password' }),
    (error: unknown) => error instanceof AppError && error.statusCode === 401 && error.message === 'Invalid email or password',
  );
});

test('current user and logout use the server-side session', async () => {
  const users = new MemoryUsers();
  const sessions = new MemorySessions();
  const service = new AuthService(users, sessions);
  const registered = await service.register({ email: 'person@example.com', password: 'correct horse battery staple', displayName: 'Person' });
  assert.equal((await service.currentUser(registered.token)).id, registered.user.id);
  await service.logout(registered.token);
  await assert.rejects(service.currentUser(registered.token), (error: unknown) => error instanceof AppError && error.statusCode === 401);
});
