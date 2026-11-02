import assert from 'node:assert/strict';
import test from 'node:test';
import { PreferenceAgent } from './preference.agent.js';
import { emptyProfile } from '../preference.domain.js';
import type { LlmGenerateInput } from '../../llm/llm.types.js';
import type { AiProvider } from '@movie-hub/contract';

test('maintenance uses the owner model with bounded data, strict output and no revision-history amplification', async () => {
  let request: LlmGenerateInput | undefined;
  const agent = new PreferenceAgent(async (ownerId) => {
    assert.equal(ownerId, 'alice');
    return {
      generate: async (input) => {
        request = input;
        return { content: '{"changes":[]}', inputTokens: 1, outputTokens: 1 };
      },
    };
  });
  const profile = emptyProfile();
  profile.revisions = [
    {
      version: 0,
      at: new Date().toISOString(),
      source: 'old',
      entries: [
        {
          id: 'old',
          section: 'explicit',
          content: 'SHOULD_NOT_REPROCESS',
          evidenceRefs: [],
          updatedAt: '',
          protected: false,
        },
      ],
    },
  ];
  assert.deepEqual(
    await agent.run(
      {
        id: 'j1',
        ownerId: 'alice',
        kind: 'chat',
        evidence: [{ ref: 'msg1', text: '今天想看战争片' }],
        attempts: 1,
        leaseId: 'lease',
        fingerprint: null,
      },
      profile,
      new AbortController().signal
    ),
    { changes: [] }
  );
  assert.equal(request?.operation, 'preference.update');
  assert.equal(request?.messages[1]?.role, 'user');
  assert.equal(request?.outputSchema?.schema.additionalProperties, false);
  assert.ok(!JSON.stringify(request).includes('SHOULD_NOT_REPROCESS'));
});

test('switching providers reuses the same owner profile and attributes new analysis to the selected model', async () => {
  let provider: AiProvider = 'openai';
  const profile = emptyProfile();
  profile.version = 4;
  profile.entries = [{ id: 'taste', section: 'explicit', content: 'Prefer science fiction',
    evidenceRefs: ['message:1'], updatedAt: new Date().toISOString(), protected: true }];
  const observed: unknown[] = [];
  const agent = new PreferenceAgent(async (ownerId) => {
    assert.equal(ownerId, 'alice');
    return {
      limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      selection: { provider, model: `${provider}-model` },
      generate: async (request) => {
        observed.push(JSON.parse(request.messages.at(-1)!.content).profile);
        assert.equal(request.maxOutputTokens, 128_000);
        return { content: '{"changes":[]}', inputTokens: 1, outputTokens: 1 };
      },
    };
  });
  const job = { id: 'job', ownerId: 'alice', kind: 'chat' as const,
    evidence: [{ ref: 'message:2', text: 'More science fiction' }], attempts: 1, leaseId: 'lease', fingerprint: null };
  const first = await agent.run(job, profile, new AbortController().signal);
  provider = 'claude';
  const second = await agent.run(job, profile, new AbortController().signal);
  assert.deepEqual(observed[0], observed[1]);
  assert.equal(first.generatedBy?.provider, 'openai');
  assert.equal(second.generatedBy?.provider, 'claude');
  assert.equal(profile.version, 4);
  assert.equal(profile.entries[0]?.protected, true);
});
