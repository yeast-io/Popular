import assert from 'node:assert/strict';
import test from 'node:test';
import { InvalidEnvironmentError, loadConfig, loadMigrationConfig, loadTrendingConfig } from './env.js';

const valid = {
  WEB_ORIGIN: 'http://localhost:5173',
  MONGODB_URI: 'mongodb://db.example/movie_hub',
  REDIS_URL: 'rediss://redis.example:6379',
  MINIO_ENDPOINT: 'minio.example',
  MINIO_ACCESS_KEY: 'access',
  MINIO_SECRET_KEY: 'secret',
  MINIO_BUCKET: 'avatars',
  SESSION_TOKEN_PEPPER: 'test-session-pepper-at-least-32-characters',
  INTEGRATION_SECRET_KEY: 'test-integration-secret-key-at-least-32-characters',
  TMDB_READ_ACCESS_TOKEN: 'test-token',
};

test('loads and normalizes valid environment', () => {
  const config = loadConfig({ ...valid, TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' });
  assert.deepEqual(config.trustProxy, ['10.0.0.0/8', '127.0.0.1']);
  assert.equal(config.PORT, 3000);
  assert.equal(config.INTEGRATION_SECRET_KEY, valid.INTEGRATION_SECRET_KEY);
  assert.deepEqual(config.MTEAM_ALLOWED_HOSTS, ['api.m-team.cc', 'api.m-team.io']);
  assert.equal(config.MTEAM_RESOURCE_CHECK_TTL_SECONDS, 86_400);
  assert.equal(config.MTEAM_RESOURCE_RETRY_DELAY_SECONDS, 300);
  assert.equal(config.MTEAM_RESOURCE_CHECK_LEASE_SECONDS, 120);
  assert.equal(config.MTEAM_SEARCH_MIN_INTERVAL_MS, 2_500);
});

test('requires a dedicated integration encryption key', () => {
  const { INTEGRATION_SECRET_KEY: _omitted, ...withoutIntegrationKey } = valid;
  assert.throws(() => loadConfig(withoutIntegrationKey), /INTEGRATION_SECRET_KEY/);
  assert.throws(() => loadConfig({ ...withoutIntegrationKey, INTEGRATION_SECRET_KEY: 'too-short' }), /INTEGRATION_SECRET_KEY/);
});

test('fails fast without infrastructure credentials', () => {
  assert.throws(() => loadConfig({ WEB_ORIGIN: 'http://localhost:5173' }), InvalidEnvironmentError);
});

test('rejects a URL in MINIO_ENDPOINT before constructing the SDK client', () => {
  assert.throws(
    () => loadConfig({ ...valid, MINIO_ENDPOINT: 'http://minio.example:9000' }),
    /without protocol, port, or path/,
  );
});

test('trending job config does not require unrelated web, session, or MinIO settings', () => {
  const config = loadTrendingConfig({
    MONGODB_URI: valid.MONGODB_URI,
    REDIS_URL: valid.REDIS_URL,
    TMDB_READ_ACCESS_TOKEN: valid.TMDB_READ_ACCESS_TOKEN,
  });
  assert.equal(config.TMDB_LANGUAGE, 'zh-CN');
  assert.equal(config.MONGODB_DB_NAME, 'movie_hub');
});

test('movie locale migration requires only MongoDB settings', () => {
  assert.deepEqual(loadMigrationConfig({
    MONGODB_URI: 'mongodb://localhost:27017',
    MONGODB_DB_NAME: 'movie_hub',
  }), {
    MONGODB_URI: 'mongodb://localhost:27017',
    MONGODB_DB_NAME: 'movie_hub',
  });
});

test('rejects an unsupported configured TMDB locale', () => {
  assert.throws(() => loadTrendingConfig({
    MONGODB_URI: valid.MONGODB_URI,
    REDIS_URL: valid.REDIS_URL,
    TMDB_READ_ACCESS_TOKEN: valid.TMDB_READ_ACCESS_TOKEN,
    TMDB_LANGUAGE: 'fr-FR',
  }), /TMDB_LANGUAGE/);
});
