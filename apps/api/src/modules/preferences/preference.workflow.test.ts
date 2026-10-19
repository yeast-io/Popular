import assert from 'node:assert/strict';
import test from 'node:test';
import { PreferenceWorkflow } from './preference.workflow.js';
import { emptyProfile } from './preference.domain.js';
import type { PreferenceJob, PreferenceStore } from './preference.types.js';

const job: PreferenceJob = {
  id: 'job1',
  ownerId: 'alice',
  kind: 'chat',
  evidence: [{ ref: 'msg1', text: '我喜欢历史片' }],
  attempts: 1,
  fingerprint: null,
  leaseId: 'lease',
};

test('workflow runs one attempt without claiming, scheduling or completing jobs', async () => {
  let saved = false;
  const store = {
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
      saved = true;
      return true;
    },
  } as unknown as PreferenceStore;
  const workflow = new PreferenceWorkflow(store, { run: async () => ({ changes: [] }) });
  assert.equal(await workflow.run(job, new AbortController().signal), true);
  assert.ok(saved);
});

test('disabled automatic maintenance skips model calls and a lost lease prevents saving', async () => {
  let calls = 0;
  const profile = emptyProfile();
  profile.autoMaintain = false;
  const store = {
    applied: async () => false,
    read: async () => profile,
    owns: async () => false,
    save: async () => {
      throw new Error('A lost lease must not save');
    },
  } as unknown as PreferenceStore;
  const workflow = new PreferenceWorkflow(store, {
    run: async () => {
      calls++;
      return { changes: [] };
    },
  });
  assert.equal(await workflow.run(job, new AbortController().signal), true);
  assert.equal(calls, 0);
  profile.autoMaintain = true;
  assert.equal(await workflow.run(job, new AbortController().signal), false);
  assert.equal(calls, 1);
});
