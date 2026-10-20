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
  assert.equal(config.REGISTRATION_USER_LIMIT, 100);
  assert.equal(config.INTEGRATION_SECRET_KEY, valid.INTEGRATION_SECRET_KEY);
  assert.deepEqual(config.MTEAM_ALLOWED_HOSTS, ['api.m-team.cc', 'api.m-team.io']);
  assert.equal(config.MTEAM_RESOURCE_AVAILABLE_TTL_SECONDS, 86_400);
  assert.equal(config.MTEAM_RESOURCE_UNAVAILABLE_TTL_SECONDS, 21_600);
  assert.equal(config.MTEAM_RESOURCE_RETRY_DELAY_SECONDS, 900);
  assert.equal(config.MTEAM_RESOURCE_CHECK_LEASE_SECONDS, 120);
  assert.equal(config.MTEAM_SEARCH_MIN_INTERVAL_MS, 2_500);
  assert.equal(config.MTEAM_RELEASE_CACHE_TTL_SECONDS, 120);
  assert.equal(config.AVATAR_MAX_BYTES, 50 * 1024 * 1024);
  assert.equal(config.AVATAR_MAX_PIXELS, 16_777_216);
});

test('validates the registration user limit', () => {
  assert.equal(loadConfig({ ...valid, REGISTRATION_USER_LIMIT: '250' }).REGISTRATION_USER_LIMIT, 250);
  assert.throws(() => loadConfig({ ...valid, REGISTRATION_USER_LIMIT: '0' }), /REGISTRATION_USER_LIMIT/);
});

test('requires a dedicated integration encryption key', () => {
  const { INTEGRATION_SECRET_KEY: _omitted, ...withoutIntegrationKey } = valid;
  assert.throws(() => loadConfig(withoutIntegrationKey), /INTEGRATION_SECRET_KEY/);
  assert.throws(
    () => loadConfig({ ...withoutIntegrationKey, INTEGRATION_SECRET_KEY: 'too-short' }),
    /INTEGRATION_SECRET_KEY/,
  );
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
  }
  );
  assert.equal(config.TMDB_LANGUAGE, 'zh-CN');
  assert.equal(config.MONGODB_DB_NAME, 'movie_hub');
});

test('movie locale migration requires only MongoDB settings', () => {
  assert.deepEqual(
    loadMigrationConfig({
      MONGODB_URI: 'mongodb://localhost:27017',
      MONGODB_DB_NAME: 'movie_hub',
    }),
    {
      MONGODB_URI: 'mongodb://localhost:27017',
      MONGODB_DB_NAME: 'movie_hub',
    },
  );
});

test('rejects an unsupported configured TMDB locale', () => {
  assert.throws(() => {
    return loadTrendingConfig({
      MONGODB_URI: valid.MONGODB_URI,
      REDIS_URL: valid.REDIS_URL,
      TMDB_READ_ACCESS_TOKEN: valid.TMDB_READ_ACCESS_TOKEN,
      TMDB_LANGUAGE: 'fr-FR',
    }
    );
  }, /TMDB_LANGUAGE/
  );
});

test('accepts a 50 MB avatar limit and rejects larger values', () => {
  assert.equal(loadConfig({ ...valid, AVATAR_MAX_BYTES: String(50 * 1024 * 1024) }).AVATAR_MAX_BYTES, 50 * 1024 * 1024);
  assert.throws(() => loadConfig({ ...valid, AVATAR_MAX_BYTES: String(50 * 1024 * 1024 + 1) }), /AVATAR_MAX_BYTES/);
});

test('enables OpenAI only with a complete bounded configuration', () => {
  const disabled = loadConfig(valid);
  assert.equal(disabled.OPENAI_MODEL, 'gpt-5.6-sol');

  const enabled = loadConfig({
    ...valid,
    OPENAI_MODEL: 'test-model',
    OPENAI_MAX_CONTEXT_TOKENS: '8192',
    OPENAI_MAX_OUTPUT_TOKENS: '1024',
  }
  );
  assert.equal(enabled.OPENAI_MODEL, 'test-model');
  assert.equal(enabled.OPENAI_MAX_CONTEXT_TOKENS, 8192);
  assert.equal(enabled.OPENAI_SUMMARY_MAX_OUTPUT_TOKENS, 500);
  assert.throws(() => {
    return loadConfig({
      ...valid,
      OPENAI_MODEL: 'test-model',
      OPENAI_MAX_CONTEXT_TOKENS: '1024',
      OPENAI_MAX_OUTPUT_TOKENS: '1024',
    }
    );
  }, /OPENAI_MAX_OUTPUT_TOKENS/
  );
  assert.throws(() => {
    return loadConfig({
      ...valid,
      OPENAI_MODEL: 'test-model',
      OPENAI_MAX_CONTEXT_TOKENS: '1024',
      OPENAI_SUMMARY_MAX_OUTPUT_TOKENS: '1024',
    }
    );
  }, /OPENAI_SUMMARY_MAX_OUTPUT_TOKENS/
  );
});

test('Telegram bot is optional; malformed tokens fail without exposing their value', () => {
  assert.equal(loadConfig(valid).TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(
    loadConfig({ ...valid, TELEGRAM_BOT_TOKEN: '123456:valid_token-1' }).TELEGRAM_BOT_TOKEN,
    '123456:valid_token-1',
  );
  const secret = 'invalid-sensitive-token';
  assert.throws(
    () => loadConfig({ ...valid, TELEGRAM_BOT_TOKEN: secret }),
    (error) => {
      assert.ok(error instanceof InvalidEnvironmentError);
      assert.ok(error.message.includes('TELEGRAM_BOT_TOKEN'));
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
});

test('validates assistant worker concurrency and recovery scan interval', () => {
  const config = loadConfig(valid);
  assert.equal(config.ASSISTANT_MAX_CONCURRENCY, 4);
  assert.equal(config.ASSISTANT_SCAN_INTERVAL_MS, 15_000);
  assert.throws(() => loadConfig({ ...valid, ASSISTANT_MAX_CONCURRENCY: '0' }), /ASSISTANT_MAX_CONCURRENCY/);
  assert.throws(() => loadConfig({ ...valid, ASSISTANT_MAX_CONCURRENCY: '1.5' }), /ASSISTANT_MAX_CONCURRENCY/);
  assert.throws(() => loadConfig({ ...valid, ASSISTANT_SCAN_INTERVAL_MS: '999' }), /ASSISTANT_SCAN_INTERVAL_MS/);
});

test('validates the graceful shutdown deadline', () => {
  assert.equal(loadConfig(valid).SHUTDOWN_TIMEOUT_MS, 30_000);
  assert.throws(() => loadConfig({ ...valid, SHUTDOWN_TIMEOUT_MS: '0' }), /SHUTDOWN_TIMEOUT_MS/);
});

test('Redis lock tracing defaults off and validates the switch for API and sync jobs', () => {
  assert.equal(loadConfig(valid).REDIS_LOCK_TRACE_ENABLED, false);
  assert.equal(loadConfig({ ...valid, REDIS_LOCK_TRACE_ENABLED: 'true' }).REDIS_LOCK_TRACE_ENABLED, true);
  assert.equal(loadConfig({ ...valid, REDIS_LOCK_TRACE_ENABLED: 'false' }).REDIS_LOCK_TRACE_ENABLED, false);
  assert.equal(loadTrendingConfig({ ...valid, REDIS_LOCK_TRACE_ENABLED: 'true' }).REDIS_LOCK_TRACE_ENABLED, true);
  assert.throws(() => loadConfig({ ...valid, REDIS_LOCK_TRACE_ENABLED: 'yes' }), /REDIS_LOCK_TRACE_ENABLED/);
});

test('Telegram polling trace defaults off and validates its independent switch', () => {
  assert.equal(loadConfig(valid).TELEGRAM_POLL_TRACE_ENABLED, false);
  assert.equal(loadConfig({ ...valid, TELEGRAM_POLL_TRACE_ENABLED: 'true' }).TELEGRAM_POLL_TRACE_ENABLED, true);
  assert.equal(loadConfig({ ...valid, TELEGRAM_POLL_TRACE_ENABLED: 'false' }).TELEGRAM_POLL_TRACE_ENABLED, false);
  assert.throws(() => loadConfig({ ...valid, TELEGRAM_POLL_TRACE_ENABLED: 'yes' }), /TELEGRAM_POLL_TRACE_ENABLED/);
});

test('scheduled scan tracing defaults off and validates its independent switch', () => {
  assert.equal(loadConfig(valid).SCAN_TRACE_ENABLED, false);
  assert.equal(loadConfig({ ...valid, SCAN_TRACE_ENABLED: 'true' }).SCAN_TRACE_ENABLED, true);
  assert.equal(loadConfig({ ...valid, SCAN_TRACE_ENABLED: 'false' }).SCAN_TRACE_ENABLED, false);
  assert.throws(() => loadConfig({ ...valid, SCAN_TRACE_ENABLED: 'yes' }), /SCAN_TRACE_ENABLED/);
});

test('parses curated model IDs in display order and validates environment overrides', () => {
  assert.deepEqual(loadConfig(valid).OPENAI_RECOMMENDED_MODELS, []);
  assert.deepEqual(
    loadConfig({ ...valid, OPENAI_RECOMMENDED_MODELS: ' gpt-6.1-sol, gpt-5.4-mini,gpt-6.1-sol,, ' })
      .OPENAI_RECOMMENDED_MODELS,
    ['gpt-6.1-sol', 'gpt-5.4-mini'],
  );
  assert.deepEqual(loadConfig({ ...valid, OPENAI_RECOMMENDED_MODELS: '' }).OPENAI_RECOMMENDED_MODELS, []);
  assert.throws(
    () => loadConfig({ ...valid, OPENAI_RECOMMENDED_MODELS: 'gpt-6-luna,invalid model' }),
    /OPENAI_RECOMMENDED_MODELS/,
  );
});

test('validates experimental page switches as explicit booleans', () => {
  const config = loadConfig(valid);
  assert.equal(config.PAGE_AI_ASSISTANT_ENABLED, true);
  assert.equal(config.PAGE_DOCS_ENABLED, false);
  assert.equal(config.VERBOSE, false);
  assert.equal(
    loadConfig({ ...valid, PAGE_AI_ASSISTANT_ENABLED: 'false', PAGE_DOCS_ENABLED: 'true' }).PAGE_DOCS_ENABLED,
    true,
  );
  for (const field of ['PAGE_AI_ASSISTANT_ENABLED', 'PAGE_DOCS_ENABLED', 'VERBOSE']) {
    assert.throws(() => loadConfig({ ...valid, [field]: 'yes' }), new RegExp(field));
  }
});

test('resource site domains are configurable HTTPS origins with no embedded secrets or paths', () => {
  const config = loadConfig(
    { ...valid, HDAREA_BASE_URL: 'https://new-hdarea.example/', MTEAM_BASE_URL: 'https://api.new-mteam.example', MTEAM_WEB_BASE_URL: 'https://new-mteam.example/' }
  );
  assert.equal(config.HDAREA_BASE_URL, 'https://new-hdarea.example');
  assert.equal(config.MTEAM_BASE_URL, 'https://api.new-mteam.example');
  assert.equal(config.MTEAM_WEB_BASE_URL, 'https://new-mteam.example');
  for (const value of ['http://site.example', 'https://user:secret@site.example', 'https://site.example?passkey=secret', 'https://site.example/download.php', 'https://site.example:8443']) {
    assert.throws(() => loadConfig({ ...valid, HDAREA_BASE_URL: value }), InvalidEnvironmentError);
  }
});
