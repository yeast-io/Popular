import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../../infrastructure/http/app-error.js';
import { verificationFixture } from './email-verification.fixtures.test.js';
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

  async updateLocale(id: string, locale: 'zh-CN' | 'en-US') {
    const user = await this.findById(id);
    if (!user) return null;
    user.locale = locale;
    return user;
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

test('registration remains unauthenticated until the email-bound code is verified', async () => {
  const users = new MemoryUsers();
  const sessions = new MemorySessions();
  const fixture = verificationFixture(users);
  const service = new AuthService(users, sessions, 100, fixture.service);
  const pending = await service.register({ email: ' PERSON@Example.COM ', password: 'correct horse battery staple', displayName: 'Person' }, 'en-US');
  assert.equal(pending.email, 'person@example.com');
  assert.equal(users.users.size, 0);
  assert.equal(sessions.sessions.size, 0);
  assert.equal(fixture.sent[0]?.locale, 'en-US');
  await assert.rejects(service.login({ email: pending.email, password: 'correct horse battery staple' }));
  await service.register({ email: pending.email, password: 'different password', displayName: 'Other' });
  assert.equal(fixture.sent.length, 1);
  const code = fixture.sent[0]!.code;
  await assert.rejects(service.verifyRegistration({ email: 'other@example.com', code, password: 'correct horse battery staple' }));
  await assert.rejects(service.verifyRegistration({ email: pending.email, code, password: 'different password' }));
  const result = await service.verifyRegistration({ email: pending.email, code, password: 'correct horse battery staple' });
  assert.equal(result.user.email, pending.email);
  assert.equal(await sessions.getOwnerId(result.token), result.user.id);
  assert.notEqual(users.users.get(pending.email)?.passwordHash, 'correct horse battery staple');
  await assert.rejects(service.verifyRegistration({ email: pending.email, code, password: 'correct horse battery staple' }));
  assert.ok((await service.login({ email: pending.email, password: 'correct horse battery staple' })).token);
});

test('expired registrations and five wrong code attempts cannot create accounts', async () => {
  const users = new MemoryUsers();
  const fixture = verificationFixture(users);
  const service = new AuthService(users, new MemorySessions(), 100, fixture.service);
  await service.register({ email: 'expired@example.com', password: 'secure password', displayName: 'Expired' });
  for (const record of fixture.records.values()) record.registration.expiresAt = Date.now() - 1;
  await assert.rejects(service.verifyRegistration({ email: 'expired@example.com', code: fixture.sent[0]!.code, password: 'secure password' }));
  await service.register({ email: 'locked@example.com', password: 'secure password', displayName: 'Locked' });
  const code = fixture.sent[1]!.code;
  const wrongCode = code === '000000' ? '111111' : '000000';
  for (let index = 0; index < 5; index++) await assert.rejects(service.verifyRegistration({ email: 'locked@example.com', code: wrongCode, password: 'secure password' }));
  await assert.rejects(service.verifyRegistration({ email: 'locked@example.com', code, password: 'secure password' }));
  assert.equal(users.users.size, 0);
});

test('send failure removes pending data and registration fails closed without Mailgun integration', async () => {
  const users = new MemoryUsers();
  const fixture = verificationFixture(users);
  fixture.failSend();
  const service = new AuthService(users, new MemorySessions(), 100, fixture.service);
  const input = { email: 'failure@example.com', password: 'secure password', displayName: 'Failure' };
  await assert.rejects(service.register(input), (error: unknown) => error instanceof AppError && error.code === 'EMAIL_VERIFICATION_UNAVAILABLE' && error.cause instanceof Error);
  assert.equal(fixture.records.size, 0);
  assert.equal(users.users.size, 0);
  await assert.rejects(new AuthService(users, new MemorySessions(), 100).register(input));
});

test('verification rechecks the user limit and serializes account creation', async () => {
  const users = new MemoryUsers();
  const fixture = verificationFixture(users, 1);
  const service = new AuthService(users, new MemorySessions(), 1, fixture.service);
  await service.register({ email: 'first@example.com', password: 'secure password', displayName: 'First' });
  await service.register({ email: 'second@example.com', password: 'secure password', displayName: 'Second' });
  const results = await Promise.allSettled(fixture.sent.map(({ email, code }) => service.verifyRegistration({ email, code, password: 'secure password' })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(users.users.size, 1);
});

test('login rejects a wrong password without revealing which credential failed', async () => {
  const service = new AuthService(new MemoryUsers(), new MemorySessions(), 100);
  await assert.rejects(
    service.login({ email: 'missing@example.com', password: 'incorrect password' }),
    (error: unknown) => {
      return error instanceof AppError && error.statusCode === 401 && error.message === 'Invalid email or password';
    });
});

test('current user and logout use the server-side session', async () => {
  const users = new MemoryUsers();
  const sessions = new MemorySessions();
  const fixture = verificationFixture(users);
  const service = new AuthService(users, sessions, 100, fixture.service);
  await service.register({
    email: 'person@example.com',
    password: 'correct horse battery staple',
    displayName: 'Person',
  }
  );
  const registered = await service.verifyRegistration({ email: 'person@example.com', code: fixture.sent[0]!.code, password: 'correct horse battery staple' });
  assert.equal((await service.currentUser(registered.token)).id, registered.user.id);
  await service.logout(registered.token);
  await assert.rejects(
    service.currentUser(registered.token),
    (error: unknown) => error instanceof AppError && error.statusCode === 401
  );
});

test('notification locale uses the account preference and defaults only for users without one', async () => {
  const users = new MemoryUsers();
  const service = new AuthService(users, new MemorySessions(), 10);
  const alice = await users.createPasswordUser({ email: 'alice@example.com', displayName: 'Alice', passwordHash: 'hash' });
  const bob = await users.createPasswordUser({ email: 'bob@example.com', displayName: 'Bob', passwordHash: 'hash' });
  assert.equal(await service.localeForOwner(alice.id, 'zh-CN'), 'zh-CN');
  await users.updateLocale(alice.id, 'en-US');
  assert.equal(await service.localeForOwner(alice.id, 'zh-CN'), 'en-US');
  assert.equal(await service.localeForOwner(bob.id, 'zh-CN'), 'zh-CN');
  await users.updateLocale(alice.id, 'zh-CN');
  assert.equal(await service.localeForOwner(alice.id, 'en-US'), 'zh-CN');
});
