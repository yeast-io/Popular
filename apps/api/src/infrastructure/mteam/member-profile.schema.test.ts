import assert from 'node:assert/strict';
import test from 'node:test';
import { MTeamMemberProfileSchema } from './member-profile.schema.js';

test('current member IDs retain precision and normalize safe numeric representations', () => {
  for (const [raw, expected] of [['90071992547409931234', '90071992547409931234'], ['000123', '123'], [123, '123']])
    assert.equal(MTeamMemberProfileSchema.parse({ data: { id: raw } }).data.id, expected);
});

test('missing, unsafe, fractional and non-positive identities cannot establish a binding', () => {
  for (const id of [undefined, null, '', '0', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1e3', ' 123 ', 'NaN', {}, '1'.repeat(33)])
    assert.equal(MTeamMemberProfileSchema.safeParse({ data: { id } }).success, false);
  assert.equal(MTeamMemberProfileSchema.safeParse({ data: [] }).success, false);
});
