import assert from 'node:assert/strict';
import test from 'node:test';
import { assistantFailureReply } from './assistant-failure.presentation.js';
import { LlmProviderError } from '../llm/llm.errors.js';

test('structured output failures explain the stopped request in both locales', () => {
  for (const reason of ['invalid_json', 'invalid_schema', 'refusal'] as const) {
    const error = new LlmProviderError('private details', undefined, { reason });
    assert.match(assistantFailureReply(error, 'zh-CN'), /处理已中止/);
    assert.match(assistantFailureReply(error, 'en-US'), /Processing stopped/);
    assert.ok(!assistantFailureReply(error, 'en-US').includes('private details'));
  }
});
