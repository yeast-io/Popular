import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config/env.js';
import { AuthService } from '../auth/auth.service.js';
import { DuplicateEmailError } from '../auth/auth.errors.js';
import type { AuthUserStore, SessionStore, StoredUser } from '../auth/auth.types.js';
import { UserService } from './user.service.js';
import type { AvatarStore } from './user.types.js';

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
  AVATAR_MAX_BYTES: '1024',
  AVATAR_MAX_PIXELS: '4',
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

class MemoryAvatars implements AvatarStore {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  async put(ownerId: string, bytes: Buffer, contentType: string) {
    const key = `users/${ownerId}/avatars/test.png`;
    this.objects.set(key, { bytes, contentType });
    return key;
  }
  async get(objectKey: string) {
    const object = this.objects.get(objectKey);
    if (!object) throw new Error('missing object');
    return { stream: Readable.from(object.bytes), contentType: object.contentType };
  }
  async delete(objectKey: string) {
    this.objects.delete(objectKey);
  }
}

async function fixture() {
  const users = new MemoryUsers();
  const sessions = new MemorySessions();
  const avatars = new MemoryAvatars();
  const auth = new AuthService(users, sessions, config.REGISTRATION_USER_LIMIT);
  const userService = new UserService(auth, users, avatars, config.AVATAR_MAX_BYTES, config.AVATAR_MAX_PIXELS);
  const app = await buildApp({ config, healthDependencies: [], authService: auth, userService });
  const registration = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email: 'person@example.com', password: 'correct horse battery staple', displayName: 'Person' },
  });
  const rawCookie = registration.headers['set-cookie'];
  const cookie = (Array.isArray(rawCookie) ? rawCookie[0] : rawCookie)?.split(';', 1)[0] ?? '';
  return { app, avatars, cookie };
}

test('authenticated user updates only their own display name', async () => {
  const { app, cookie } = await fixture();
  const response = await app.inject({
    method: 'PATCH',
    url: '/api/v1/users/me',
    headers: { cookie },
    payload: { displayName: '  New Name  ' },
  }
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().user.displayName, 'New Name');
  assert.equal(response.json().user.email, 'person@example.com');
  await app.close();
});

test('avatar upload validates file bytes and supports authenticated read and delete', async () => {
  const { app, avatars, cookie } = await fixture();
  const png = pngHeader(1, 1);
  const upload = await app.inject({
    method: 'PUT',
    url: '/api/v1/users/me/avatar',
    headers: { cookie, 'content-type': 'image/png' },
    payload: png,
  }
  );
  assert.equal(upload.statusCode, 200);
  assert.match(upload.json().user.avatarUrl, /^\/api\/v1\/users\/me\/avatar\?v=/);
  assert.equal(avatars.objects.size, 1);

  const read = await app.inject({ method: 'GET', url: '/api/v1/users/me/avatar', headers: { cookie } });
  assert.equal(read.statusCode, 200);
  assert.equal(read.headers['content-type'], 'image/png');
  assert.deepEqual(read.rawPayload, png);

  const deletion = await app.inject({ method: 'DELETE', url: '/api/v1/users/me/avatar', headers: { cookie } });
  assert.equal(deletion.statusCode, 204);
  assert.equal(avatars.objects.size, 0);
  const afterDelete = await app.inject({ method: 'GET', url: '/api/v1/users/me/avatar', headers: { cookie } });
  assert.equal(afterDelete.statusCode, 404);
  await app.close();
});

test('avatar upload rejects content that is not a supported image', async () => {
  const { app, cookie } = await fixture();
  const response = await app.inject({
    method: 'PUT',
    url: '/api/v1/users/me/avatar',
    headers: { cookie, 'content-type': 'image/png' },
    payload: Buffer.from('not an image'),
  }
  );
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  await app.close();
});

test('avatar upload enforces the configured pixel limit', async () => {
  const { app, cookie } = await fixture();
  const response = await app.inject({
    method: 'PUT',
    url: '/api/v1/users/me/avatar',
    headers: { cookie, 'content-type': 'image/png' },
    payload: pngHeader(3, 2),
  }
  );
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  await app.close();
});

test('avatar upload enforces the configured byte limit', async () => {
  const { app, cookie } = await fixture();
  const oversized = Buffer.alloc(1025);
  oversized.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const response = await app.inject({
    method: 'PUT',
    url: '/api/v1/users/me/avatar',
    headers: { cookie, 'content-type': 'image/png' },
    payload: oversized,
  }
  );
  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error.code, 'BAD_REQUEST');
  await app.close();
});

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
