import assert from 'node:assert/strict';
import test from 'node:test';
import { Utf8ByteTokenCounter } from './utf8-byte-token-counter.js';

test('counts UTF-8 bytes conservatively for English and Chinese text', () => {
  const counter = new Utf8ByteTokenCounter();
  assert.equal(counter.count('hello'), 5);
  assert.equal(counter.count('电影'), 6);
});
