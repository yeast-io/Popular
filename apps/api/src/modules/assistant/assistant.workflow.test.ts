import { ASSISTANT_INTENT_SYSTEM_PROMPT } from '../../config/system-prompts/assistant.prompts.js';
import type { PreferenceService } from '../preferences/preference.service.js';
import type { LlmClient } from '../llm/llm.types.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantWorkflow } from './assistant.workflow.js';
import type { AssistantInputWorkflowMessage } from './assistant.types.js';
import type { LlmGenerateInput } from '../llm/llm.types.js';

const input: AssistantInputWorkflowMessage = {
  ownerId: 'alice',
  channel: 'telegram',
  chatId: '101',
  messageId: '1',
  text: 'What do you think of Spider-Man?',
  receivedAt: '2026-10-18T00:00:00.000Z',
};
const options = { systemPrompt: 'Be concise.', maxContextTokens: 8_000, maxOutputTokens: 500 };

test('web workflow streams discussion through the same assistant after classification', async () => {
  let calls = 0;
  const workflow = new AssistantWorkflow(async () => {
    return {
      generate: async () => {
        calls++;
        return { content: '{"intent":"discuss","preferenceSignal":"none"}', inputTokens: 1, outputTokens: 1 };
      },
      stream: async function* (request) {
        assert.equal(request.operation, 'assistant.discuss');
        assert.ok(request.messages.at(-1)?.content === input.text);
        yield { type: 'delta', delta: 'Shared assistant reply' };
        yield { type: 'completed', inputTokens: 3, outputTokens: 4 };
      },
    };
  }, options);
  const result = await workflow.run({ ...input, channel: 'web' }, [], undefined, true);
  assert.equal(result.intent, 'discuss');
  assert.equal(result.replyText, '');
  const events = [];
  for await (const event of result.stream!) events.push(event);
  assert.equal(events[0]?.type, 'delta');
  assert.equal(calls, 1);
});

test('discussion routes through the graph using the owner client and bounded chat history', async () => {
  const owners: string[] = [];
  const requests: LlmGenerateInput[] = [];
  const runner = new AssistantWorkflow(async (ownerId) => {
    owners.push(ownerId);
    return {
      generate: async (request) => {
        requests.push(request);
        return {
          content: requests.length === 1 ? '{"intent":"discuss"}' : 'Which Spider-Man movie?',
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };
  }, options);
  const result = await runner.run(input, [{ role: 'user', content: 'I like animation.' }]);
  assert.deepEqual(result, { intent: 'discuss', replyText: 'Which Spider-Man movie?' });
  assert.deepEqual(owners, ['alice']);
  assert.equal(requests.length, 2);
  assert.ok(requests[0]!.outputSchema);
  assert.equal(requests[1]!.messages.at(-1)!.content, input.text);
  assert.ok(requests[1]!.messages.some((message) => message.content === 'I like animation.'));
});

for (const intent of ['recommend', 'resources', 'download', 'unclear'] as const) {
  test(`${intent} answers unavailable capabilities without invoking business actions`, async () => {
    let calls = 0;
    const runner = new AssistantWorkflow(async () => {
      return {
        generate: async (request) => {
          calls++;
          return { content: request.operation === 'assistant.intent' ? JSON.stringify(
            { intent }
          ) : 'Capability-aware answer', inputTokens: 1, outputTokens: 1 };
        },
      };
    }, options);
    const result = await runner.run(input);
    assert.equal(result.intent, intent);
    assert.equal(calls, intent === 'unclear' ? 1 : 2);
    assert.match(result.replyText, intent === 'unclear' ? /补充/ : /Capability-aware answer/);
  });
}

test('invalid classifier output fails instead of becoming unclear', async () => {
  const runner = new AssistantWorkflow(async () => {
    return {
      generate: async () => {
        return {
          content: '{"intent":"execute_shell"}',
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };
  }, options);
  await assert.rejects(runner.run(input));
});

test('invalid input is rejected before key resolution or model calls', async () => {
  let called = false;
  const runner = new AssistantWorkflow(async () => {
    called = true;
    throw new Error();
  }, options);
  await assert.rejects(runner.run({ ...input, text: '  ' }));
  assert.equal(called, false);
});

test('oversized context is rejected and pre-aborted runs never call the model', async () => {
  let calls = 0;
  const runner = new AssistantWorkflow(
    async () => {
      return {
        generate: async () => {
          calls++;
          throw new Error('Should not reach the provider');
        },
      };
    },
    { ...options, maxContextTokens: 1_024 },
  );
  await assert.rejects(runner.run({ ...input, text: '电影'.repeat(1_000) }), /context budget/);
  await assert.rejects(runner.run(input, [], AbortSignal.abort()));
  assert.equal(calls, 0);
});

function createWorkflow(llm: Pick<LlmClient, 'generate'>, config: ConstructorParameters<typeof AssistantWorkflow>[1]) {
  return new AssistantWorkflow(async () => llm, config);
}

const routingInput: AssistantInputWorkflowMessage = {
  ownerId: 'alice',
  channel: 'telegram',
  chatId: '101',
  messageId: '2',
  text: 'The second one',
  receivedAt: '2026-10-18T00:00:00.000Z',
};
const routingOptions = { systemPrompt: 'Be concise.', maxContextTokens: 8_000, maxOutputTokens: 500 };

test('long-term evidence is independent of primary intent and maintenance failure does not block the reply', async () => {
  let scheduled = false,
    reported = false;
  const preferences = {
    chatEvidence: async (ownerId: string, _event: string, text: string) => {
      assert.equal(ownerId, 'alice');
      assert.equal(text, routingInput.text);
      scheduled = true;
      throw new Error('queue unavailable');
    },
    store: { read: async () => ({ entries: [] }) },
  } as unknown as PreferenceService;
  const agent = createWorkflow(
    {
      generate: async (request) => {
        return {
          content: request.outputSchema ? '{"intent":"discuss","preferenceSignal":"explicit"}' : 'Reply still works',
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    },
    {
      ...routingOptions,
      preferences,
      report: () => {
        reported = true;
      },
    },
  );
  assert.equal((await agent.run(routingInput)).replyText, 'Reply still works');
  assert.ok(scheduled && reported);
});

test('personal assistant detects intent using the latest message and conversation context in separate roles', async () => {
  let request: LlmGenerateInput | undefined;
  const agent = createWorkflow(
    {
      generate: async (value) => {
        if (value.operation === 'assistant.intent') request = value;
        return { content: '{"intent":"download"}', inputTokens: 1, outputTokens: 1 };
      },
    },
    routingOptions,
  );
  const history = [{ role: 'assistant' as const, content: 'Which release would you like to download?' }];
  assert.equal((await agent.run(routingInput, history)).intent, 'download');
  assert.deepEqual(request!.messages, [
    { role: 'system', content: ASSISTANT_INTENT_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: routingInput.text },
  ]
  );
  assert.equal(request!.outputSchema!.schema.additionalProperties, false);
  assert.ok(!JSON.stringify(request).includes(routingInput.ownerId));
});

test('only the five supported intents are accepted, including explicit unclear results', async () => {
  for (const intent of ['discuss', 'recommend', 'resources', 'download', 'unclear']) {
    const agent = createWorkflow(
      {
        generate: async () => {
          return { content: JSON.stringify({ intent }), inputTokens: 1, outputTokens: 1 };
        },
      },
      routingOptions,
    );
    assert.equal((await agent.run(routingInput)).intent, intent);
  }
});

test('malformed, unknown, and extra model output fields fail instead of being routed', async () => {
  for (const content of ['not json', '{"intent":"execute"}', '{"intent":"download","confirmed":true}', '{}']) {
    const agent = createWorkflow(
      { generate: async () => ({ content, inputTokens: 1, outputTokens: 1 }) },
      routingOptions,
    );
    await assert.rejects(agent.run(routingInput));
  }
});

test('provider failures propagate and cancellation discards late classification results', async () => {
  const failed = createWorkflow(
    {
      generate: async () => {
        throw new Error('upstream failure');
      },
    },
    routingOptions,
  );
  await assert.rejects(failed.run(routingInput), /upstream failure/);
  const controller = new AbortController();
  const agent = createWorkflow(
    {
      generate: async (request) => {
        assert.ok(request.signal);
        controller.abort();
        assert.equal(request.signal.aborted, true);
        return { content: '{"intent":"download"}', inputTokens: 1, outputTokens: 1 };
      },
    },
    routingOptions,
  );
  await assert.rejects(agent.run(routingInput, [], controller.signal), { name: 'AbortError' });
});

test('the same personal assistant detects an intent and handles the discussion response', async () => {
  const requests: LlmGenerateInput[] = [];
  const agent = createWorkflow(
    {
      generate: async (request) => {
        requests.push(request);
        return {
          content: requests.length === 1 ? '{"intent":"discuss"}' : 'A general conversation reply.',
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    },
    routingOptions,
  );
  assert.deepEqual(await agent.run(routingInput), { intent: 'discuss', replyText: 'A general conversation reply.' });
  assert.ok(requests[0]!.outputSchema);
  assert.equal(requests[1]!.outputSchema, undefined);
  assert.equal(requests[1]!.maxOutputTokens, routingOptions.maxOutputTokens);
});

test('unavailable capabilities generate an answer while ambiguous legacy requests still clarify', async () => {
  for (const intent of ['recommend', 'resources', 'download', 'unclear'] as const) {
    let calls = 0;
    const agent = createWorkflow(
      {
        generate: async (request) => {
          calls++;
          return { content: request.operation === 'assistant.intent' ? JSON.stringify(
            { intent }
          ) : 'Capability-aware answer', inputTokens: 1, outputTokens: 1 };
        },
      },
      routingOptions,
    );
    const result = await agent.run(routingInput);
    assert.equal(calls, intent === 'unclear' ? 1 : 2);
    assert.equal(result.intent, intent);
    assert.match(result.replyText, intent === 'unclear' ? /补充/ : /Capability-aware answer/);
  }
});

test('discussion rejects empty responses and discards late results after cancellation', async () => {
  const empty = createWorkflow(
    {
      generate: async (request) => {
        return {
          content: request.outputSchema ? '{"intent":"discuss"}' : '  ',
          inputTokens: 1,
          outputTokens: 0,
        };
      },
    },
    routingOptions,
  );
  await assert.rejects(empty.run(routingInput), /empty reply/);
  const controller = new AbortController();
  const agent = createWorkflow(
    {
      generate: async (request) => {
        if (request.outputSchema) return { content: '{"intent":"discuss"}', inputTokens: 1, outputTokens: 1 };
        controller.abort();
        return { content: 'Late response', inputTokens: 1, outputTokens: 1 };
      },
    },
    routingOptions,
  );
  await assert.rejects(agent.run(routingInput, [], controller.signal), { name: 'AbortError' });
});

for (const channel of ['telegram', 'whatsapp', 'web'] as const) {
  test(`${channel} preserves the textual recommendation and only messaging channels receive poster metadata`, async () => {
    const replyText = 'Recommendation '.repeat(200);
    const movies = [{ tmdbId: 1, title: 'Movie', reason: 'Reason', posterPath: '/poster.jpg' }];
    const recommendations = {
      runResult: async () => ({ replyText, movies }),
    } as unknown as import('../recommendations/recommendation.types.js').RecommendationCapability;
    const workflow = new AssistantWorkflow(
      async () => {
        return {
          generate: async () => {
            return {
              content: '{"intent":"recommend","preferenceSignal":"none"}',
              inputTokens: 1,
              outputTokens: 1,
            };
          },
        };
      },
      { ...options, recommendations },
    );
    const result = await workflow.run({ ...input, channel });
    assert.equal(result.replyText, replyText);
    assert.equal(result.intent, 'recommend');
    assert.deepEqual(result.movies, channel === 'web' ? undefined : movies);
  });
}

test('recommendation tools use the same owner assistant for intent, planning and ranking while preferences enqueue independently', async () => {
  const { emptyProfile } = await import('../preferences/preference.domain.js');
  const operations: Array<string | undefined> = [];
  let enqueued = false,
    credentials = 0;
  const recommendations: import('../recommendations/recommendation.types.js').RecommendationCapability = {
    active: async () => false,
    runResult: async (ownerId, conversation, eventId, text, history, decisions, signal) => {
      assert.equal(ownerId, 'alice');
      assert.equal(conversation, 'web:101');
      assert.equal(eventId, 'web:101:1');
      assert.equal(text, input.text);
      assert.ok(enqueued);
      const plan = await decisions.plan(
        emptyProfile(),
        0,
        [...history, { role: 'user', content: text }],
        signal!,
        'zh-CN',
      );
      const ranked = await decisions.rank(
        emptyProfile(),
        history,
        [{ tmdbId: 1, title: 'Candidate', genreIds: [], genres: [], directors: [], cast: [] }],
        signal!,
        'zh-CN',
        plan,
      );
      return { replyText: `Candidate: ${ranked.movies[0]?.reason}` };
    },
  };
  const preferences = {
    chatEvidence: async () => {
      enqueued = true;
    },
  } as unknown as PreferenceService;
  const workflow = new AssistantWorkflow(
    async (ownerId) => {
      assert.equal(ownerId, 'alice');
      credentials++;
      return {
        generate: async (request) => {
          operations.push(request.operation);
          const content =
            request.outputSchema?.name === 'assistant_intent'
              ? { intent: 'recommend', preferenceSignal: 'explicit' }
              : request.outputSchema?.name === 'recommendation_plan'
                ? {
                    requestedCount: 1,
                    softPreferences: [],
                    recommendNow: true,
                    question: null,
                    genres: [],
                    excludeGenres: [],
                    referenceTitle: null,
                    maxRuntime: null,
                    language: null,
                    unverifiableRestrictions: [],
                  }
                : { movies: [{ tmdbId: 1, reason: 'Matches the request' }] };
          return { content: JSON.stringify(content), inputTokens: 1, outputTokens: 1 };
        },
      };
    },
    { ...options, recommendations, preferences },
  );
  const result = await workflow.run({ ...input, channel: 'web' }, [], new AbortController().signal);
  assert.equal(result.replyText, 'Candidate: Matches the request');
  assert.equal(credentials, 1);
  assert.deepEqual(operations, ['assistant.intent', 'assistant.recommend', 'assistant.recommend']);
});

for (const channel of ['web', 'telegram', 'whatsapp'] as const) {
  test(`resource queries use shared owner agent planning on ${channel}`, async () => {
    const operations: Array<string | undefined> = [];
    let invoked = false;
    const resources: import('../resource-query/resource-query.types.js').ResourceQueryCapability = {
      active: async () => true,
      run: async (ownerId, conversation, eventId, text, history, decisions, signal) => {
        invoked = true;
        assert.equal(ownerId, 'alice');
        assert.equal(conversation, `${channel}:101`);
        assert.equal(eventId, `${channel}:101:1`);
        const plan = await decisions.plan(text, history, {
          candidates: [], movie: null, resolution: null, providers: [],
          sources: [{ id: 'mteam', name: 'M-Team' }], releaseCount: 0, page: 1, pageCount: 0,
        }, 'zh-CN', signal ?? new AbortController().signal
        );
        assert.equal(plan.title, 'Interstellar');
        assert.equal(plan.resolution, '2160p');
        return { replyText: 'M-Team: found a real release' };
      },
    };
    const workflow = createWorkflow({ generate: async (request) => {
      operations.push(request.operation);
      const content = request.operation === 'assistant.intent'
        ? { intent: 'resources', preferenceSignal: 'none' }
        : { title: 'Interstellar', year: 2014, candidateId: null, resolution: '2160p',
          providers: null, releaseIndex: null, page: null, refresh: false, question: null, unsupported: [] };
      return { content: JSON.stringify(content), inputTokens: 1, outputTokens: 1 };
    } }, { ...options, resources }
    );
    const result = await workflow.run({ ...input, channel });
    assert.equal(invoked, true);
    assert.equal(result.intent, 'resources');
    assert.match(result.replyText, /real release/);
    assert.deepEqual(operations, ['assistant.intent', 'assistant.resources.plan']);
  });
}

test('unclear resource follow-ups use persisted context, while download intent cannot invoke resource operations', async () => {
  let calls = 0;
  let intent = 'unclear';
  const resources: import('../resource-query/resource-query.types.js').ResourceQueryCapability = {
    active: async () => true,
    run: async () => { calls++; return { replyText: 'Filtered result' }; },
  };
  const workflow = createWorkflow({ generate: async (request) => {
    return ({
      content: request.operation === 'assistant.intent' ? JSON.stringify(
        { intent, preferenceSignal: 'none' }
      ) : 'Cannot submit downloads here', inputTokens: 1, outputTokens: 1,
    });
  } }, { ...options, resources }
  );
  assert.equal((await workflow.run(input)).intent, 'resources');
  intent = 'download';
  const result = await workflow.run({ ...input, messageId: '2' });
  assert.equal(result.intent, 'download');
  assert.equal(result.replyText, 'Cannot submit downloads here');
  assert.equal(calls, 1);
});

test('resource tool failure cannot masquerade as no resources or a successful query', async () => {
  const workflow = createWorkflow({ generate: async () => {
    return ({
      content: '{"intent":"resources","preferenceSignal":"none"}', inputTokens: 1, outputTokens: 1,
    });
  } }, { ...options, resources: {
    active: async () => false,
    run: async () => { throw new Error('TMDB unreachable'); },
  } }
  );
  assert.match((await workflow.run(input)).replyText, /未完成.*无法判断/);
});

for (const channel of ['telegram', 'whatsapp'] as const) {
  test(`resource replies preserve all ten rows and long detail metadata on ${channel}`, async () => {
    const replyText = Array.from(
      { length: 10 },
      (_, i) => `${i + 1}. 4K · ${'组'.repeat(40)} · 50.00 GiB · 做种 1069`
    ).join(
      '\n'
    ) +
      '\n' + '完整文件名'.repeat(300) + '\nID: last-release';
    assert.ok(replyText.length > 1800 && replyText.length < 4000);
    const workflow = createWorkflow({ generate: async () => {
      return ({
        content: '{"intent":"resources","preferenceSignal":"none"}', inputTokens: 1, outputTokens: 1,
      });
    } }, { ...options, resources: { active: async () => false, run: async () => ({ replyText }) } }
    );
    assert.equal((await workflow.run({ ...input, channel })).replyText, replyText);
  });
}
