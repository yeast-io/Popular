import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateSiteChecks } from './movie-site-resources.domain.js';

test('only all successful, current negative results can mean no resource is available', () => {
  const empty = {
    provider: 'mteam',
    availability: 'unavailable' as const,
    checking: false,
    lastAttemptStatus: 'success' as const,
  };
  const failed = {
    provider: 'hdarea',
    availability: 'unchecked' as const,
    checking: false,
    lastAttemptStatus: 'error' as const,
  };
  assert.equal(aggregateSiteChecks([empty, failed]).availability, 'unchecked');
  assert.equal(aggregateSiteChecks([empty, failed]).incomplete, true);
  assert.equal(aggregateSiteChecks([empty, { ...empty, provider: 'hdarea' }]).availability, 'unavailable');
  assert.equal(aggregateSiteChecks([{ ...empty, availability: 'available' }, failed]).availability, 'available');
  assert.equal(aggregateSiteChecks([{ ...empty, availability: 'available' }, failed]).incomplete, true);
  assert.equal(
    aggregateSiteChecks([{ ...empty, availability: 'available', expiresAt: '2020-01-01T00:00:00Z' }]).availability,
    'unchecked'
  );
  assert.equal(aggregateSiteChecks([]).availability, 'unchecked');
});
