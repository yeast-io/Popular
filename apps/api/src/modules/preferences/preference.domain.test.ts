import type { PreferenceProposal } from './preference.types.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyProposal, emptyProfile, profileText } from './preference.domain.js';

const change = {
  operation: 'add' as const,
  entryId: null,
  section: 'inferred' as const,
  content: '可能喜欢诺兰作品',
  evidenceRefs: ['movie:1:liked'],
  reason: '电影共同导演',
};
test('movie inference preserves provenance and never becomes an explicit statement', () => {
  const profile = applyProposal(emptyProfile(), { changes: [change] }, ['movie:1:liked'], 'manual', 'job1');
  assert.equal(profile.entries[0]?.section, 'inferred');
  assert.deepEqual(profile.entries[0]?.evidenceRefs, ['movie:1:liked']);
  assert.match(profileText(profile), /可能喜欢诺兰/);
  assert.throws(() => {
    return applyProposal(
      profile,
      { changes: [{ ...change, section: 'explicit' }] },
      change.evidenceRefs,
      'manual',
      'job2'
    );
  });
});
test('unknown sources, cross-entry targets and protected corrections are rejected atomically', () => {
  const profile = applyProposal(emptyProfile(), { changes: [change] }, change.evidenceRefs, 'manual', 'job1');
  assert.throws(() => {
    return applyProposal(
      profile,
      { changes: [{ ...change, evidenceRefs: ['another-user'] }] },
      change.evidenceRefs,
      'manual',
      'job2'
    );
  });
  assert.throws(() => {
    return applyProposal(
      profile,
      { changes: [{ ...change, operation: 'replace', entryId: 'unknown' }] },
      change.evidenceRefs,
      'manual',
      'job2'
    );
  });
  profile.entries[0]!.protected = true;
  const edits: PreferenceProposal = { changes: [{ ...change, operation: 'remove', entryId: profile.entries[0]!.id }] };
  assert.throws(() => applyProposal(profile, edits, change.evidenceRefs, 'manual', 'job2'));
  assert.equal(profile.entries.length, 1);
});
test('withdrawn movie evidence cannot resurrect a removed preference', () => {
  const profile = emptyProfile();
  profile.withdrawn = change.evidenceRefs;
  assert.equal(applyProposal(profile, { changes: [change] }, change.evidenceRefs, 'manual', 'job').entries.length, 0);
});
test('regeneration removes unsupported inferences while preserving explicit entries', () => {
  const profile = applyProposal(emptyProfile(), { changes: [change] }, change.evidenceRefs, 'manual', 'job1');
  profile.entries.push({
    id: 'manual',
    section: 'explicit',
    content: '喜欢历史片',
    evidenceRefs: ['message1'],
    protected: true,
    updatedAt: new Date().toISOString(),
  }
  );
  const next = applyProposal(profile, { changes: [] }, ['movie:2:disliked'], 'manual', 'job2');
  assert.deepEqual(
    next.entries.map((entry) => entry.id),
    ['manual']
  );
  assert.equal(next.revisions.at(-1)?.entries.length, 2);
});
test('chat changes are explicit and cannot rewrite inferred entries or duplicate the same preference', () => {
  const entry = { ...change, section: 'explicit' as const, content: '长期喜欢战争片', evidenceRefs: ['message1'] };
  const profile = applyProposal(emptyProfile(), { changes: [entry, entry] }, ['message1'], 'chat', 'job');
  assert.equal(profile.entries.length, 1);
  assert.throws(() => applyProposal(profile, { changes: [change] }, change.evidenceRefs, 'chat', 'job2'));
});
