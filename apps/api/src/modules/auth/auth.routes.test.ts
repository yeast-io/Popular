import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config/env.js';
import { verificationFixture } from './email-verification.fixtures.test.js';
import { AuthService } from './auth.service.js';
import { DuplicateEmailError } from './auth.errors.js';
import type { AuthUserStore, SessionStore, StoredUser } from './auth.types.js';

const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:5173',
  MONGODB_URI: 'mongodb://db.example/movie_hub',
  REDIS_URL: 'redis://redis.example:6379',
  MINIO_ENDPOINT: 'minio.example',
  MINIO_ACCESS_KEY: 'access',
  MINIO_SECRET_KEY: 'secret',
  MINIO_BUCKET: 'avatars',
  SESSION_TOKEN_PEPPER: 'test-session-pepper-at-least-32-characters',
  INTEGRATION_SECRET_KEY: 'test-integration-secret-key-at-least-32-characters',
  TMDB_READ_ACCESS_TOKEN: 'test-token',
  ACCESS_LOG_ENABLED: 'false',
});

class MemoryUsers implements AuthUserStore {
  readonly users = new Map<string, StoredUser>();

  async countUsers() {
    return this.users.size;
  }

  async createPasswordUser(input: Omit<StoredUser, 'id'>) {
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
    const token = `session-${ownerId}`;
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

test('registration requires verification before a cookie authenticates /me and logout clears it', async () => {
  const users = new MemoryUsers();
  const fixture = verificationFixture(users);
  const app = await buildApp({
    config,
    healthDependencies: [],
    authService: new AuthService(users, new MemorySessions(), config.REGISTRATION_USER_LIMIT, fixture.service),
  }
  );

  const registration = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email: 'person@example.com', password: 'correct horse battery staple', displayName: 'Person' },
  }
  );
  assert.equal(registration.statusCode, 202);
  assert.equal(registration.headers['set-cookie'], undefined);
  assert.equal(registration.json().email, 'person@example.com');
  const unverifiedLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'person@example.com', password: 'correct horse battery staple' } });
  assert.equal(unverifiedLogin.statusCode, 401);
  const verification = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', payload: { email: 'person@example.com', code: fixture.sent[0]!.code, password: 'correct horse battery staple' } });
  assert.equal(verification.statusCode, 200);
  assert.equal(verification.json().user.email, 'person@example.com');
  const replay = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', payload: { email: 'person@example.com', code: fixture.sent[0]!.code, password: 'correct horse battery staple' } });
  assert.equal(replay.statusCode, 400);
  const rawSetCookie = verification.headers['set-cookie'];
  const setCookie = Array.isArray(rawSetCookie) ? rawSetCookie[0] : rawSetCookie;
  assert.match(setCookie ?? '', /^movie_hub_session=session-1;/);
  assert.match(setCookie ?? '', /HttpOnly/);
  assert.match(setCookie ?? '', /SameSite=Lax/);

  const cookie = setCookie?.split(';', 1)[0];
  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookie ?? '' } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.email, 'person@example.com');

  const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: cookie ?? '' } });
  assert.equal(logout.statusCode, 204);
  const rawClearCookie = logout.headers['set-cookie'];
  const clearCookie = Array.isArray(rawClearCookie) ? rawClearCookie[0] : rawClearCookie;
  assert.match(clearCookie ?? '', /Max-Age=0/);
  const afterLogout = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookie ?? '' } });
  assert.equal(afterLogout.statusCode, 401);
  await app.close();
});

test('registration validates password length before calling the service', async () => {
  const app = await buildApp({
    config,
    healthDependencies: [],
    authService: new AuthService(new MemoryUsers(), new MemorySessions(), config.REGISTRATION_USER_LIMIT),
  }
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email: 'person@example.com', password: 'short', displayName: 'Person' },
  }
  );
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  await app.close();
});

test('registration returns a stable API error when the user limit is reached', async () => {
  const users = new MemoryUsers();
  await users.createPasswordUser({ email: 'first@example.com', passwordHash: 'hash', displayName: 'First' });
  const fixture = verificationFixture(users, 1);
  const app = await buildApp({ config, healthDependencies: [], authService: new AuthService(users, new MemorySessions(), 1, fixture.service) });
  const rejected = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'second@example.com', password: 'correct horse battery staple', displayName: 'Second' } });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.json().error.code, 'REGISTRATION_LIMIT_REACHED');
  assert.equal(fixture.sent.length, 0);
  await app.close();
});

test('registration quota and Mailgun failures are localized and never issue sessions', async () => {
  const users = new MemoryUsers();
  const fixture = verificationFixture(users);
  fixture.exhaustQuota();
  const app = await buildApp({ config, healthDependencies: [], authService: new AuthService(users, new MemorySessions(), 100, fixture.service) });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { 'accept-language': 'en-US' },
      payload: { email: 'person@example.com', password: 'secure password', displayName: 'Person' } });
    assert.equal(response.statusCode, 429);
    assert.equal(response.json().error.code, 'EMAIL_VERIFICATION_LIMIT_REACHED');
    assert.match(response.json().error.message, /24 hours/);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(users.users.size, 0);
    assert.equal(fixture.sent.length, 0);
  } finally { await app.close(); }

  const failing = verificationFixture(users);
  failing.failSend();
  const failedApp = await buildApp({ config, healthDependencies: [], authService: new AuthService(users, new MemorySessions(), 100, failing.service) });
  try {
    const response = await failedApp.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { 'accept-language': 'zh-CN' },
      payload: { email: 'person@example.com', password: 'secure password', displayName: 'Person' } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'EMAIL_VERIFICATION_UNAVAILABLE');
    assert.match(response.json().error.message, /无法发送/);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(users.users.size, 0);
  } finally { await failedApp.close(); }
});
