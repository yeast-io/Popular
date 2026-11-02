import assert from 'node:assert/strict';
import test from 'node:test';
import type { AiProvider } from '@movie-hub/contract';
import type { ResolvedUserLlm } from './llm-model.types.js';
import { UserLlmService } from './user-llm.service.js';
import { modelLimits } from '../integrations/ai-provider.policy.js';

test('each user resolves only their default provider; existing clients retain their model after a switch', async () => {
  const defaults: Record<string, AiProvider> = { alice: 'openai', bob: 'deepseek' };
  const calls: Array<{ ownerId: string; provider: string; model: string; tokens: number }> = [];
  const selected: ResolvedUserLlm[] = [];
  const models = { openai: 'gpt-5.6-sol', deepseek: 'deepseek-flash', claude: 'claude-sonnet-5-5' };
  const service = new UserLlmService({
    defaultProvider: async (ownerId) => defaults[ownerId],
    credentials: async (ownerId, provider) => ({ apiKey: `${ownerId}-${provider}-private`, model: models[provider] }),
    createClient: (resolved, ownerId) => {
      selected.push(resolved);
      return {
        generate: async (input) => {
          calls.push({ ownerId, provider: resolved.provider, model: resolved.model, tokens: input.maxOutputTokens });
          return { content: 'ok', inputTokens: 1, outputTokens: 1 };
        },
        stream: async function* () { yield { type: 'completed', inputTokens: 1, outputTokens: 1 }; },
      };
    },
  });
  const first = await service.create('alice');
  defaults.alice = 'claude';
  await first.generate({ messages: [], maxOutputTokens: 256, operation: 'preference.update' });
  const second = await service.create('alice');
  await second.generate({ messages: [], maxOutputTokens: 256, operation: 'assistant.recommend' });
  const bob = await service.create('bob');
  await bob.generate({ messages: [], maxOutputTokens: 256 });
  assert.deepEqual(calls.map(({ ownerId, provider }) => ({ ownerId, provider })), [
    { ownerId: 'alice', provider: 'openai' }, { ownerId: 'alice', provider: 'claude' }, { ownerId: 'bob', provider: 'deepseek' },
  ]);
  assert.equal(first.limits?.contextWindow, 1_050_000);
  assert.equal(calls[0]?.tokens, 128_000);
  assert.equal(calls[2]?.tokens, 393_216);
  assert.equal(selected[2]?.apiKey, 'bob-deepseek-private');
});

test('missing defaults, missing credentials and unknown capabilities never fall back to another provider', async () => {
  let selected: string | undefined = undefined;
  let model = 'unknown-model';
  let reads = 0;
  const service = new UserLlmService({
    defaultProvider: async () => selected,
    credentials: async () => {
      reads++;
      return { apiKey: 'private', model };
    },
    createClient: () => { throw new Error('must not construct'); },
  });
  await assert.rejects(service.create('alice'), { code: 'AI_NOT_CONFIGURED' });
  assert.equal(reads, 0);
  selected = 'claude';
  await assert.rejects(service.create('alice'), { code: 'AI_MODEL_UNSUPPORTED' });
  model = 'gpt-5.6-sol';
  await assert.rejects(service.create('alice'), { code: 'AI_MODEL_UNSUPPORTED' });
  assert.equal(modelLimits('openai', 'gpt-5.6-sol-2026-10-01')?.contextWindow, 1_050_000);
  assert.equal(modelLimits('openai', 'toString'), undefined);
});
