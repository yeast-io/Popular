import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serializeDiagnosticError } from '@movie-hub/contract';
import { scrubGatewayDiagnostic } from './gateway-logging.service.js';
import { configSchema } from './gateway.schema.js';

test('diagnostics retain stack/cause with full URL and credential redaction; verbose is a strict boolean', () => {
  const cause = new Error('https://tracker.invalid/path?unusual=SEED_SECRET');
  const error = new Error('Bearer API_SECRET', { cause });
  const safe = scrubGatewayDiagnostic(serializeDiagnosticError(error));
  const text = JSON.stringify(safe);
  assert.ok(!text.includes('SEED_SECRET') && !text.includes('API_SECRET'));
  assert.ok(text.includes('stack') && text.includes('cause') && text.includes('gateway-logging.service.test.ts'));
  const config = {
    REDIS_URL: 'redis://localhost',
    INTERNAL_INBOUND_TOKEN: 'i'.repeat(32),
    SIGNING_PRIVATE_KEY_FILE: '/test/key.json',
    SIGNING_KEY_ID: 'key-1',
  };
  assert.equal(configSchema.parse(config).VERBOSE, false);
  assert.equal(configSchema.parse({ ...config, VERBOSE: 'true' }).VERBOSE, true);
  assert.throws(() => configSchema.parse({ ...config, VERBOSE: '1' }));
});
