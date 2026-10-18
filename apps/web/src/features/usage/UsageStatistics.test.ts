// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import UsageStatistics from './UsageStatistics.vue';

beforeEach(() => { setLocale('en-US'); });
afterEach(() => { vi.unstubAllGlobals(); });

it('shows OpenAI with partial token totals and a model/operation breakdown, without fees', async () => {
  const tokenUsage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40,
    knownRequests: 1, unknownRequests: 1, unknownCachedRequests: 1 };
  const metrics = { requests: 2, successes: 1, failures: 1, averageDurationMs: 500, tokenUsage };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    range: { days: 30, retentionDays: 90 }, totals: metrics,
    providers: [{ provider: 'openai', ...metrics }], daily: [],
    operations: [{ provider: 'openai', operation: 'assistant.intent', ...metrics }],
    models: [{ provider: 'openai', model: 'test-model', operation: 'assistant.intent', ...metrics }],
  })));
  const wrapper = mount(UsageStatistics); await flushPromises();
  expect(wrapper.text()).toContain('OpenAI');
  expect(wrapper.text()).toContain('100 + ?');
  expect(wrapper.text()).toContain('Cached input tokens');
  expect(wrapper.text()).toContain('Token usage unavailable for 1 requests.');
  expect(wrapper.text()).toContain('test-model');
  expect(wrapper.text()).toContain('Assistant intent detection');
  expect(wrapper.text()).not.toContain('$');
  wrapper.unmount();
});

it('shows unknown instead of zero when no model request returned usage', async () => {
  const tokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
    knownRequests: 0, unknownRequests: 1, unknownCachedRequests: 1 };
  const metrics = { requests: 1, successes: 0, failures: 1, averageDurationMs: 1, tokenUsage };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    range: { days: 30, retentionDays: 90 }, totals: metrics,
    providers: [{ provider: 'openai', ...metrics }], daily: [], operations: [],
  })));
  const wrapper = mount(UsageStatistics); await flushPromises();
  expect(wrapper.findAll('.usage-provider-grid dd').slice(-3).map(node => node.text())).toEqual(['Unknown', 'Unknown', 'Unknown']);
  wrapper.unmount();
});
