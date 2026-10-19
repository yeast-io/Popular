import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config/env.js';
import { AuthService } from './auth.service.js';
import { DuplicateEmailError, type AuthUserStore, type SessionStore, type StoredUser } from './auth.types.js';

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

test('registration cookie authenticates /me and logout clears it', async () => {
  const app = await buildApp({
    config,
    healthDependencies: [],
    authService: new AuthService(new MemoryUsers(), new MemorySessions(), config.REGISTRATION_USER_LIMIT),
  }
  );

  const registration = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email: 'person@example.com', password: 'correct horse battery staple', displayName: 'Person' },
  }
  );
  assert.equal(registration.statusCode, 201);
  assert.deepEqual(registration.json(), { user: { id: '1', email: 'person@example.com', displayName: 'Person' } });
  const rawSetCookie = registration.headers['set-cookie'];
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
  const app = await buildApp({
    config,
    healthDependencies: [],
    authService: new AuthService(users, new MemorySessions(), 1),
  }
  );
  const payload = { password: 'correct horse battery staple', displayName: 'Person' };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { ...payload, email: 'first@example.com' },
      }
      )
    ).statusCode,
    201,
  );
  const rejected = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { ...payload, email: 'second@example.com' },
  }
  );
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.json().error.code, 'REGISTRATION_LIMIT_REACHED');
  assert.equal(users.users.size, 1);
  await app.close();
});
