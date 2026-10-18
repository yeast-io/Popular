import assert from 'node:assert/strict';
import test from 'node:test';
import { PreferenceAgent } from './preference.agent.js';
import { emptyProfile } from '../preference.domain.js';
import type { LlmGenerateInput } from '../../llm/llm.types.js';

test('maintenance uses the owner model with bounded data, strict output and no revision-history amplification', async () => {
  let request: LlmGenerateInput | undefined;
  const agent = new PreferenceAgent(async ownerId => {
    assert.equal(ownerId, 'alice');
    return { generate: async input => { request = input; return { content: '{"changes":[]}', inputTokens: 1, outputTokens: 1 }; } };
  });
  const profile = emptyProfile();
  profile.revisions = [{ version: 0, at: new Date().toISOString(), source: 'old', entries: [{ id: 'old', section: 'explicit', content: 'SHOULD_NOT_REPROCESS', evidenceRefs: [], updatedAt: '', protected: false }] }];
  assert.deepEqual(await agent.run({ id: 'j1', ownerId: 'alice', kind: 'chat', evidence: [{ ref: 'msg1', text: '今天想看战争片' }], attempts: 1, leaseId: 'lease', fingerprint: null }, profile, new AbortController().signal), { changes: [] });
  assert.equal(request?.operation, 'preference.update');
  assert.equal(request?.messages[1]?.role, 'user');
  assert.equal(request?.outputSchema?.schema.additionalProperties, false);
  assert.ok(!JSON.stringify(request).includes('SHOULD_NOT_REPROCESS'));
});
