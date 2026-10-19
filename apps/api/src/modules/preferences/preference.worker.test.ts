import assert from 'node:assert/strict';
import test from 'node:test';
import { PreferenceWorkflow } from './preference.workflow.js';
import { PreferenceWorker } from './preference.worker.js';
import type { PreferenceAgent } from './agents/preference.agent.js';
import type { PreferenceStore, PreferenceJob } from './preference.types.js';
import { emptyProfile } from './preference.domain.js';

const job: PreferenceJob = {
  id: 'job1',
  ownerId: 'alice',
  kind: 'chat',
  evidence: [{ ref: 'msg1', text: '我一直喜欢战争片' }],
  attempts: 1,
  fingerprint: null,
  leaseId: 'lease1',
};
test('preference workflow validates evidence and uses version fencing before saving', async () => {
  let saved = false,
    completed = false;
  const store = {
    claim: async () => {
      return job;
    },
    applied: async () => {
      return false;
    },
    read: async () => {
      return emptyProfile();
    },
    owns: async () => {
      return true;
    },
    save: async (owner: string, version: number) => {
      assert.equal(owner, 'alice');
      assert.equal(version, 0);
      saved = true;
      return true;
    },
    finish: async (_job: PreferenceJob, error?: string) => {
      assert.equal(error, undefined);
      completed = true;
    },
  } as unknown as PreferenceStore;
  const agent = {
    run: async () => {
      return {
        changes: [
          {
            operation: 'add',
            entryId: null,
            section: 'explicit',
            content: '喜欢战争片',
            evidenceRefs: ['msg1'],
            reason: '明确表达',
          },
        ],
      };
    },
  } as unknown as PreferenceAgent;
  await new PreferenceWorker(store, new PreferenceWorkflow(store, agent), { error: () => {} }).tick();
  assert.ok(saved && completed);
});
test('recovered tasks already applied do not repeat model calls', async () => {
  let completed = false;
  const store = {
    claim: async () => {
      return job;
    },
    applied: async () => {
      return true;
    },
    finish: async () => {
      completed = true;
    },
  } as unknown as PreferenceStore;
  const agent = {
    run: async () => {
      throw new Error('must not be called');
    },
  } as unknown as PreferenceAgent;
  await new PreferenceWorker(store, new PreferenceWorkflow(store, agent), { error: () => {} }).tick();
  assert.ok(completed);
});
test('version conflicts schedule failure recovery instead of overwriting user corrections', async () => {
  let failed = false;
  const store = {
    claim: async () => {
      return job;
    },
    applied: async () => {
      return false;
    },
    read: async () => {
      return emptyProfile();
    },
    owns: async () => {
      return true;
    },
    save: async () => {
      return false;
    },
    finish: async (_job: PreferenceJob, error?: string) => {
      failed = Boolean(error);
    },
  } as unknown as PreferenceStore;
  const agent = { run: async () => ({ changes: [] }) } as unknown as PreferenceAgent;
  await new PreferenceWorker(store, new PreferenceWorkflow(store, agent), { error: () => {} }).tick();
  assert.ok(failed);
});

test('model failures log the precise stage and original cause without exposing evidence or API keys', async () => {
  const { PreferenceAgent } = await import('./agents/preference.agent.js');
  const logs: Record<string, unknown>[] = [];
  const secretEvidence = 'PRIVATE_TASTE_EVIDENCE';
  const failure = new Error('Provider failed', {
    cause: Object.assign(new Error(`Invalid schema sk-secret123 ${secretEvidence}`), {
      status: 400,
      code: 'invalid_json_schema',
    }
    ),
  });
  let finished = false;
  const store = {
    claim: async () => {
      return { ...job, evidence: [{ ref: 'msg1', text: secretEvidence }] };
    },
    applied: async () => {
      return false;
    },
    read: async () => {
      return emptyProfile();
    },
    finish: async (_job: PreferenceJob, error?: string) => {
      assert.ok(error);
      finished = true;
    },
  } as unknown as PreferenceStore;
  const agent = new PreferenceAgent(async () => ({
    generate: async () => {
      throw failure;
    },
  }));
  await new PreferenceWorker(store, new PreferenceWorkflow(store, agent), {
    error: (fields: unknown) => {
      return logs.push(fields as Record<string, unknown>);
    },
  }).tick();
  assert.ok(finished);
  assert.equal(logs[0]?.event, 'preference_task_failed');
  assert.equal(logs[0]?.stage, 'preference.model.generate');
  assert.equal(logs[0]?.jobId, job.id);
  assert.equal(logs[0]?.attempt, 1);
  assert.equal(logs[0]?.willRetry, true);
  const diagnostic = logs[0]?.error as { stack: string; cause: { status: number; code: string } };
  assert.ok(diagnostic.stack);
  assert.equal(diagnostic.cause.status, 400);
  assert.equal(diagnostic.cause.code, 'invalid_json_schema');
  assert.ok(!JSON.stringify(logs).includes(secretEvidence));
  assert.ok(!JSON.stringify(logs).includes('sk-secret123'));
});

test('failure recording errors cannot hide the original error, and final attempts do not promise retries', async () => {
  const logs: Record<string, unknown>[] = [];
  const store = {
    claim: async () => ({ ...job, attempts: 3 }),
    applied: async () => false,
    read: async () => {
      throw new Error('Profile database unavailable');
    },
    finish: async () => {
      throw new Error('Task database unavailable');
    },
  } as unknown as PreferenceStore;
  const agent = { run: async () => ({ changes: [] }) };
  await new PreferenceWorker(store, new PreferenceWorkflow(store, agent), {
    error: (fields: unknown) => {
      return logs.push(fields as Record<string, unknown>);
    },
  }).tick();
  assert.equal(logs.length, 2);
  assert.equal(logs[0]?.stage, 'preference.profile.read');
  assert.equal(logs[1]?.stage, 'preference.task.record_failure');
  assert.equal(logs[0]?.willRetry, false);
  assert.match(JSON.stringify(logs[0]), /Profile database unavailable/);
  assert.match(JSON.stringify(logs[1]), /Task database unavailable/);
});

test('metadata enrichment failures are distinguishable from model errors', async () => {
  const logs: Record<string, unknown>[] = [];
  let modelCalled = false;
  const store = {
    claim: async () => {
      return { ...job, kind: 'manual' };
    },
    applied: async () => {
      return false;
    },
    read: async () => {
      return emptyProfile();
    },
    finish: async () => {},
  } as unknown as PreferenceStore;
  const workflow = new PreferenceWorkflow(
    store,
    {
      run: async () => {
        modelCalled = true;
        return { changes: [] };
      },
    },
    async () => {
      throw new Error('Movie feedback changed; generate again');
    },
  );
  await new PreferenceWorker(store, workflow, {
    error: (fields: unknown) => {
      return logs.push(fields as Record<string, unknown>);
    },
  }).tick();
  assert.equal(modelCalled, false);
  assert.equal(logs[0]?.stage, 'preference.evidence.enrich');
});

test('malformed model output reports parsing without leaking JSON error snippets', async () => {
  const { PreferenceAgent } = await import('./agents/preference.agent.js');
  const logs: Record<string, unknown>[] = [];
  const store = {
    claim: async () => {
      return job;
    },
    applied: async () => {
      return false;
    },
    read: async () => {
      return emptyProfile();
    },
    finish: async () => {},
  } as unknown as PreferenceStore;
  const agent = new PreferenceAgent(async () => {
    return {
      generate: async () => {
        return { content: '{"changes": [PRIVATE_MODEL_OUTPUT', inputTokens: 1, outputTokens: 1 };
      },
    };
  });
  await new PreferenceWorker(store, new PreferenceWorkflow(store, agent), {
    error: (fields: unknown) => {
      return logs.push(fields as Record<string, unknown>);
    },
  }).tick();
  assert.equal(logs[0]?.stage, 'preference.proposal.parse');
  assert.match(JSON.stringify(logs), /invalid JSON/);
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_MODEL_OUTPUT'));
});

for (const verbose of [false, true]) {
  test(`background preference tracing retains the originating correlation and respects verbose=${verbose}`, async () => {
    const infos: Record<string, unknown>[] = [];
    const errors: Record<string, unknown>[] = [];
    const store = {
      claim: async () => {
        return { ...job, correlationId: 'originating-chat-turn' };
      },
      finish: async () => {},
    } as unknown as PreferenceStore;
    const failure = new Error('background failed', { cause: new Error('original cause') });
    const worker = new PreferenceWorker(
      store,
      {
        run: async () => {
          throw failure;
        },
      },
      {
        info: (fields: unknown) => {
          infos.push(fields as Record<string, unknown>);
        },
        error: (fields: unknown) => {
          errors.push(fields as Record<string, unknown>);
        },
      },
      verbose,
    );
    await worker.tick();
    assert.equal(infos.length > 0, verbose);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.correlationId, 'originating-chat-turn');
    assert.equal(errors[0]?.stage, 'preference.workflow.run');
    assert.equal((errors[0]?.error as { stack: string }).stack, failure.stack);
    assert.ok(infos.every((entry) => entry.correlationId === 'originating-chat-turn'));
    assert.doesNotMatch(JSON.stringify([...infos, ...errors]), /我一直喜欢战争片/);
  });
}
