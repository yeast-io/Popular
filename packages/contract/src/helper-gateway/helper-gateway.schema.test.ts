import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { AgentQueueSnapshotSchema } from './helper-gateway.schema.js';

test('queue snapshots carry bounded per-torrent cooldown metadata without accepting credentials', () => {
  const item = { commandId: 'command', resourceId: '42', source: 'mteam', title: null,
    enqueuedAt: 1000, expiresAt: 7 * 86400000, reason: 'torrent_daily_limit',
    limitDetectedAt: 2000, lastAttemptAt: 2000, nextAttemptAt: 86402000 };
  const snapshot = { observedAt: 3000, total: 1, nextCursor: null, items: [item] };
  assert.equal(Value.Check(AgentQueueSnapshotSchema, snapshot), true);
  assert.equal(Value.Check(AgentQueueSnapshotSchema, { ...snapshot, items: [{ ...item, torrentUrl: 'https://tracker.invalid/?passkey=SECRET' }] }), false);
  for (const nextAttemptAt of [-1, 'tomorrow', Number.MAX_SAFE_INTEGER + 1])
    assert.equal(Value.Check(AgentQueueSnapshotSchema, { ...snapshot, items: [{ ...item, nextAttemptAt }] }), false);
});
