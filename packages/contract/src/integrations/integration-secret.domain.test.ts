import assert from 'node:assert/strict';
import test from 'node:test';
import { maskIntegrationSecret } from './integration-secret.domain.js';

test('preserves first six, last six, and actual length for long credentials', () => {
  assert.equal(maskIntegrationSecret('abcdef123456uvwxyz'), 'abcdef••••••uvwxyz');
  for (const length of [13, 20, 32, 128, 2000]) {
    const value = 'x'.repeat(length);
    const masked = maskIntegrationSecret(value);
    assert.equal(
      masked.length, length
    );
    assert.equal(
      masked.slice(0, 6),
      'xxxxxx'
    );
    assert.equal(
      masked.slice(-6),
      'xxxxxx'
    );
    assert.equal(masked.slice(6, -6), '•'.repeat(length - 12));
  }
});
test('never reveals overlapping ends of short secrets and counts Unicode characters', () => {
  for (let length = 1; length <= 12; length++) assert.equal(
    maskIntegrationSecret('a'.repeat(length)),
    '•'.repeat(length)
  );
  const value = '😀'.repeat(14);
  const masked = maskIntegrationSecret(value);
  assert.equal(Array.from(masked).length, 14);
  assert.equal(masked, '😀'.repeat(6) + '••' + '😀'.repeat(6));
});
