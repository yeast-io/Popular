import assert from 'node:assert/strict';
import test from 'node:test';
import { ResourceSearchService } from './resource-search.service.js';

test('searches use the current owner selection while settings can still discover disabled sources', async () => {
  const calls: string[] = [];
  let enabled = ['mteam'];
  const service = new ResourceSearchService(['mteam', 'hdarea'].map((id) => ({
    id, name: id, details: false,
    status: async () => 'configured_valid' as const,
    search: async (ownerId) => {
      calls.push(`${ownerId}:${id}`);
      return { releases: [] };
    },
  })), async (ownerId) => ownerId === 'alice' ? enabled : ['hdarea']);
  assert.deepEqual((await service.list('alice')).sources.map((source) => source.id), ['mteam', 'hdarea']);
  const signal = new AbortController().signal;
  await assert.rejects(service.search('alice', 'hdarea', { query: 'Show S01' }, signal), { code: 'INTEGRATION_DEFAULT_INVALID' });
  assert.deepEqual(calls, []);
  await service.search('alice', 'mteam', { query: 'Show S01' }, signal);
  await service.search('bob', 'hdarea', { query: 'Show S01' }, signal);
  enabled = ['mteam', 'hdarea'];
  await service.search('alice', 'hdarea', { query: 'Show S01' }, signal);
  assert.deepEqual(calls, ['alice:mteam', 'bob:hdarea', 'alice:hdarea']);
});
