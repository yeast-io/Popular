import { AiTrace, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantWorkflow } from './assistant.workflow.js';
import type { AssistantInputWorkflowMessage, AssistantIntent, AssistantWorkflowOptions } from './assistant.types.js';
import type { LlmGenerateInput } from '../llm/llm.types.js';
import type { PreferenceService } from '../preferences/preference.service.js';
import { emptyProfile } from '../preferences/preference.domain.js';
import { emptyAssistantSession } from './assistant-session.domain.js';
import type { AssistantSession } from './assistant-session.types.js';

const input: AssistantInputWorkflowMessage = {
  ownerId: 'alice', channel: 'web', chatId: 'routing-thread', messageId: 'turn-1',
  text: 'private-user-message', receivedAt: new Date().toISOString(),
};
const defaults = { systemPrompt: 'Be concise.', maxContextTokens: 8_000, maxOutputTokens: 500 };
function workflow(intent: AssistantIntent, options: Partial<AssistantWorkflowOptions>, preferenceSignal = 'none') {
  return new AssistantWorkflow(async () => {
    return ({ generate: async (request) => {
      return ({
        content: request.operation === 'assistant.intent'
          ? JSON.stringify({ intent, preferenceSignal, locale: options.locale }) : 'Discussion reply',
        inputTokens: 1, outputTokens: 1,
      });
    } });
  }, { ...defaults, ...options });
}

for (const locale of ['en-US', 'zh-CN'] as const) {
  test(`workflow routes unclear follow-ups only to a single active task and clarifies conflicts (${locale})`, async () => {
    for (const [resourcesActive, recommendationsActive] of [[false, false], [true, false], [false, true], [true, true]]) {
      const calls: string[] = [];
      const scopes: string[][] = [];
      const traceEvents: Record<string, unknown>[] = [];
      const runner = workflow('unclear', {
        locale,
        diagnostics: { verbose: true, logger: {
          info: (fields: unknown) => { traceEvents.push(fields as Record<string, unknown>); },
          error: () => assert.fail('Successful routing must not log errors'),
        } },
        resources: {
          active: async (owner, conversation) => { scopes.push([owner, conversation]); return resourcesActive!; },
          run: async (owner, conversation, eventId, _text, _history, _decisions, signal, replyLocale) => {
            assert.equal(owner, input.ownerId);
            assert.equal(conversation, 'web:routing-thread');
            assert.equal(eventId, 'web:routing-thread:turn-1');
            assert.equal(replyLocale, locale);
            assert.equal(signal?.aborted, false);
            calls.push('resources');
            return { replyText: 'Real resource result' };
          },
        },
        recommendations: {
          active: async (owner, conversation) => { scopes.push([owner, conversation]); return recommendationsActive!; },
          runResult: async (_owner, _conversation, _event, _text, _history, _decisions, _signal, replyLocale) => {
            assert.equal(replyLocale, locale);
            calls.push('recommend');
            return { replyText: 'Real recommendation result' };
          },
        },
      }
      );
      const result = await runner.run(input);
      assert.deepEqual(scopes, [['alice', 'web:routing-thread'], ['alice', 'web:routing-thread']]);
      if (resourcesActive !== recommendationsActive) {
        const expected = resourcesActive ? 'resources' : 'recommend';
        assert.equal(result.intent, expected);
        assert.deepEqual(calls, [expected]);
      } else {
        assert.equal(result.intent, 'unclear');
        assert.deepEqual(calls, []);
        assert.match(result.replyText, resourcesActive
          ? locale === 'en-US' ? /Both a resource query/ : /都有效/
          : locale === 'en-US' ? /Please clarify/ : /补充/
        );
      }
      assert.ok(traceEvents.some((event) => event.stage === 'assistant.route.selected'));
      assert.ok(traceEvents.every((event) => typeof event.correlationId === 'string'));
      assert.equal(new Set(traceEvents.map((event) => event.correlationId)).size, 1);
      assert.doesNotMatch(JSON.stringify(traceEvents), /private-user-message/);
    }
  });

  test(`missing capabilities return generated answers without executing tools (${locale})`, async () => {
    for (const intent of ['resources', 'recommend', 'download'] as const) {
      const result = await workflow(intent, { locale }).run(input);
      assert.equal(result.intent, intent);
      assert.equal(result.replyText, 'Discussion reply');
      if (locale === 'en-US') assert.doesNotMatch(result.replyText, /\p{Script=Han}/u);
    }
  });

  test(`tool failures preserve correlated original diagnostics and return localized replies (${locale})`, async () => {
    for (const intent of ['recommend', 'resources'] as const) {
      const errors: Record<string, unknown>[] = [];
      const cause = new Error('original transport failure');
      const error = new Error('capability failed', { cause });
      const fail = (stage: string): never => {
        const trace = new AiTrace({ error: (fields: unknown) => {
          errors.push(fields as Record<string, unknown>);
        } }, { correlationId: currentAiTrace()?.correlationId }, input.text, 'test.tool', false);
        trace.fail(error, { stage });
        throw error;
      };
      const runner = workflow(intent, {
        locale,
        diagnostics: { verbose: false, logger: { error: (fields: unknown) => {
          errors.push(fields as Record<string, unknown>);
        } } },
        resources: { active: async () => false, run: async () => fail('assistant.tool.resources') },
        recommendations: { active: async () => false, runResult: async () => fail('assistant.tool.recommendations') },
      }
      );
      const result = await runner.run(input);
      assert.equal(result.intent, intent);
      assert.match(result.replyText, locale === 'en-US' ? /did not complete/ : /未完成/);
      assert.ok(
        errors.some(
          (entry) => {
            return entry.stage === (intent === 'recommend' ? 'assistant.tool.recommendations' : 'assistant.tool.resources');
          })
      );
      assert.match(JSON.stringify(errors), /original transport failure/);
      assert.match(JSON.stringify(errors), /stack/);
      assert.doesNotMatch(JSON.stringify(errors), /private-user-message/);
    }
  });
}

test('explicit requests bypass old active-task lookups and execute their workflow node', async () => {
  for (const intent of ['discuss', 'recommend', 'resources'] as const) {
    const calls: string[] = [];
    const active = async () => { assert.fail('Explicit requests must not guess from prior sessions'); };
    const result = await workflow(intent, {
      resources: { active, run: async () => { calls.push('resources'); return { replyText: 'Resources' }; } },
      recommendations: { active, runResult: async () => {
        calls.push('recommend');
        return { replyText: 'Recommendations' };
      } },
    }
    ).run(
      input
    );
    assert.equal(result.intent, intent);
    assert.deepEqual(calls, intent === 'discuss' ? [] : [intent]);
  }
});

test('preference enqueue remains independent of the main route without running background maintenance inline', async () => {
  for (const intent of ['discuss', 'resources', 'recommend', 'download', 'unclear'] as const) {
    const calls: string[] = [];
    const preferences = {
      chatEvidence: async (owner: string, eventId: string) => {
        assert.equal(owner, input.ownerId);
        assert.equal(eventId, 'web:routing-thread:turn-1');
        calls.push('enqueue');
      },
    } as unknown as PreferenceService;
    const result = await workflow(intent, {
      preferences,
      resources: { active: async () => {
        return false;
      }, run: async () => {
        calls.push('resources');
        return { replyText: 'Resources' };
      } },
      recommendations: { active: async () => {
        return false;
      }, runResult: async () => {
        calls.push('recommend');
        return { replyText: 'Recommendations' };
      } },
    }, 'explicit'
    ).run(
      input
    );
    assert.equal(result.intent, intent);
    assert.equal(calls[0], 'enqueue');
    assert.equal(calls.filter((call) => call === 'enqueue').length, 1);
  }
});

test('workflow reads profile context for both normal and streamed discussion using the same scoped owner', async () => {
  for (const streaming of [false, true]) {
    let read = false;
    const profile = emptyProfile();
    const seen: LlmGenerateInput[] = [];
    // A non-empty profile comes from the real profile domain shape.
    profile.entries.push(
      { id: 'taste-1', section: 'explicit', content: 'private-profile-evidence', evidenceRefs: [], protected: true, updatedAt: new Date().toISOString() }
    );
    const preferences = { store: { read: async (owner: string) => {
      assert.equal(owner, input.ownerId); read = true; return profile;
    } } } as unknown as PreferenceService;
    const runner = new AssistantWorkflow(async () => {
      return ({
        generate: async (request) => {
          seen.push(request);
          return { content: request.operation === 'assistant.intent' ? '{"intent":"discuss","preferenceSignal":"none"}' : 'Profile-aware reply', inputTokens: 1, outputTokens: 1 };
        },
        stream: async function* (request) {
          seen.push(request);
          yield { type: 'delta', delta: 'Profile-aware reply' };
          yield { type: 'completed', inputTokens: 1, outputTokens: 1 };
        },
      });
    }, { ...defaults, preferences });
    const result = await runner.run(input, [], undefined, streaming);
    assert.equal(read, true);
    if (streaming) for await (const _event of result.stream!) { /* consume model stream */ }
    assert.ok(seen.at(-1)?.messages.some((message) => message.content.includes('private-profile-evidence')));
  }
});

test('cancellation after active-task resolution cannot dispatch business operations', async () => {
  const controller = new AbortController();
  const runner = workflow('unclear', {
    resources: {
      active: async () => { controller.abort(); return true; },
      run: async () => { assert.fail('Cancelled route must not execute'); },
    },
  }
  );
  await assert.rejects(runner.run(input, [], controller.signal), { name: 'AbortError' });
});

test('topic switches leave download selection before workflow dispatches the new request', async () => {
  for (const intent of ['discuss', 'recommend', 'resources', 'download'] as const) {
    let session: AssistantSession = {
      ...emptyAssistantSession(), updatedAt: new Date().toISOString(), stage: 'await_provider',
      selection: { tmdbId: 157336, source: 'mteam', releaseId: 'old-release', title: 'Old release', selectedAt: new Date().toISOString() },
      providers: ['qbittorrent', 'transmission'],
    };
    let creates = 0;
    const runner = new AssistantWorkflow(async () => {
      return ({ generate: async (request) => {
        return ({
          content: request.operation === 'assistant.intent' ? JSON.stringify({ intent, preferenceSignal: 'none' })
            : request.operation === 'assistant.download.plan' ? '{"action":"other","releaseIndex":null,"provider":null}' : 'Discussion reply',
          inputTokens: 1, outputTokens: 1,
        });
      } });
    }, {
      ...defaults,
      sessions: {
        ensure: async () => {}, acquire: async () => true, read: async () => structuredClone(session),
        save: async (_owner, _conversation, _lease, next) => {
          session = structuredClone(next);
          return true;
        }, release: async () => {},
      },
      downloads: { providersFor: async () => {
        return ['qbittorrent'];
      }, createForOwner: async () => {
        creates++;
        throw new Error('Unexpected download');
      } },
      resources: { active: async () => {
        return false;
      }, context: async () => {
        return null;
      }, run: async () => {
        return ({ replyText: 'Resources' });
      } },
      recommendations: { active: async () => false, runResult: async () => ({ replyText: 'Recommendations' }) },
    });
    const result = await runner.run(input);
    assert.equal(result.intent, intent === 'download' ? 'unclear' : intent);
    assert.equal(session.stage, 'idle');
    assert.equal(session.selection, undefined);
    assert.equal(creates, 0);
  }
});

test('route context failures preserve the failing stage and original cause with verbose disabled', async () => {
  const logs: unknown[] = [];
  const failure = new Error('context read failed', { cause: new Error('database unavailable') });
  const runner = workflow('unclear', {
    diagnostics: { verbose: false, logger: { error: (...args: unknown[]) => { logs.push(args); } } },
    resources: {
      active: async () => { throw failure; },
      run: async () => { assert.fail('Failed context resolution must not dispatch a resource query'); },
    },
  }
  );
  await assert.rejects(runner.run(input), (error) => error === failure);
  assert.match(JSON.stringify(logs), /assistant.route.resources.active/);
  assert.match(JSON.stringify(logs), /database unavailable/);
  assert.doesNotMatch(JSON.stringify(logs), /private-user-message/);
});

for (const locale of ['en-US', 'zh-CN'] as const) {
  test(`download planning and checkpoint recovery pass through the unified route (${locale})`, async () => {
    for (const stage of ['idle', 'await_movie', 'await_resource', 'await_provider', 'submitting'] as const) {
      const resume = stage === 'submitting';
      let session: AssistantSession = {
        ...emptyAssistantSession(), updatedAt: new Date().toISOString(), stage,
        ...(resume || stage === 'await_provider' ? {
          selection: { tmdbId: 157336, source: 'mteam', releaseId: 'fixed-release', title: 'Fixed release', selectedAt: new Date().toISOString() },
          providers: ['transmission' as const], provider: 'transmission' as const,
        } : {}),
        ...(resume ? { submissionEventId: 'web:routing-thread:turn-1' } : {}),
      };
      const routes: Record<string, unknown>[] = [];
      let planned = 0, submitted = 0;
      const runner = new AssistantWorkflow(async () => {
        return ({ generate: async (request) => {
          if (request.operation === 'assistant.intent') return {
            // Existing stages must work even when the latest message alone is discussion/unclear.
            content: JSON.stringify(
              { intent: stage === 'idle' ? 'download' : 'unclear', preferenceSignal: 'none', locale }
            ), inputTokens: 1, outputTokens: 1,
          };
          assert.equal(request.operation, 'assistant.download.plan');
          planned++;
          return { content: '{"action":"clarify","releaseIndex":null,"provider":null}', inputTokens: 1, outputTokens: 1 };
        } });
      }, {
        ...defaults, locale,
        diagnostics: { verbose: true, logger: {
          info: (event: unknown) => {
            const fields = event as Record<string, unknown>;
            if (fields.stage === 'assistant.route.selected') routes.push(fields);
          },
          error: () => assert.fail('Unified download routing must not fail'),
        } },
        sessions: {
          ensure: async () => {}, acquire: async () => true, read: async () => structuredClone(session),
          save: async (_owner, _conversation, _lease, next) => {
            session = structuredClone(next);
            return true;
          }, release: async () => {},
        },
        resources: {
          active: async () => { assert.fail('Download routing must not resolve old resource sessions'); },
          context: async () => null,
          run: async () => { assert.fail('Clarification/recovery must not query resources'); },
        },
        recommendations: {
          active: async () => { assert.fail('Download routing must not resolve old recommendation sessions'); },
          runResult: async () => { assert.fail('Download routing must not recommend'); },
        },
        downloads: {
          providersFor: async () => { assert.fail('Recovery must reuse the pinned downloader'); },
          createForOwner: async (owner, tmdbId, releaseId, provider) => {
            submitted++;
            assert.equal(session.stage, 'submitting');
            assert.equal(owner, 'alice');
            assert.equal(releaseId, 'fixed-release');
            assert.equal(provider, 'transmission');
            return { id: 'recovered-task', tmdbId, sourceProvider: 'mteam', sourceReleaseId: releaseId, provider, status: 'submitting', progress: 0 };
          },
        },
      });
      const result = await runner.run(input);
      assert.equal(result.intent, 'download');
      assert.equal(routes.length, 1, 'Every download must traverse resolve_route exactly once');
      assert.equal(routes[0]?.intent, 'download');
      assert.equal(routes[0]?.resumeSubmission, resume);
      assert.equal(planned, resume ? 0 : 1);
      assert.equal(submitted, resume ? 1 : 0);
      if (locale === 'en-US') assert.doesNotMatch(result.replyText, /\p{Script=Han}/u);
    }
  });
}
