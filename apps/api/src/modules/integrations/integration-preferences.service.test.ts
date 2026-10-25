import assert from 'node:assert/strict';
import test from 'node:test';
import { IntegrationPreferencesService } from './integration-preferences.service.js';
import type {
  IntegrationChoice,
  IntegrationPreferencesRecord,
  IntegrationPreferencesStore,
} from './integration-preferences.types.js';

function harness() {
  const rows = new Map<string, IntegrationPreferencesRecord>();
  const read = async (owner: string) => structuredClone(rows.get(owner) ?? { defaults: {}, selectedSites: [] });
  const choices: IntegrationChoice[] = [
    { category: 'resource', id: 'mteam', name: 'M-Team', status: 'configured_valid' },
    { category: 'resource', id: 'hdarea', name: 'HDArea', status: 'configured_valid' },
    { category: 'downloader', id: 'transmission', name: 'Transmission', status: 'configured_valid' },
    { category: 'ai', id: 'openai', name: 'OpenAI', status: 'configured_valid' },
  ];
  const store: IntegrationPreferencesStore = {
    read,
    async setDefault(owner, category, id, onlyIfMissing) {
      const row = await read(owner);
      if (!onlyIfMissing || !row.defaults[category]) row.defaults[category] = id;
      rows.set(owner, row);
    },
    async selectSites(owner, sites) {
      const row = await read(owner);
      row.selectedSites = sites;
      rows.set(owner, row);
    },
    async remove(owner, category, id) {
      const row = await read(owner);
      if (row.defaults[category] === id) delete row.defaults[category];
      if (category === 'resource') row.selectedSites = row.selectedSites.filter((site) => site !== id);
      rows.set(owner, row);
    },
  };
  return { service: new IntegrationPreferencesService(store, async () => choices), choices, rows };
}
test('defaults and explicit selections are owner scoped; clearing a selection restores the primary site', async () => {
  const { service } = harness();
  assert.deepEqual((await service.get('alice')).defaults, {
    resource: 'mteam',
    downloader: 'transmission',
    ai: 'openai',
  }
  );
  await service.setDefault('alice', 'resource', 'hdarea');
  assert.deepEqual((await service.get('alice')).effectiveSites, ['mteam', 'hdarea']);
  assert.deepEqual((await service.get('bob')).effectiveSites, ['mteam']);
  await service.selectSites('alice', ['mteam', 'hdarea']);
  assert.deepEqual((await service.get('alice')).effectiveSites, ['mteam', 'hdarea']);
  await service.selectSites('alice', []);
  assert.deepEqual((await service.get('alice')).effectiveSites, ['hdarea']);
});
test('a failed primary remains selected; invalid and unconfigured alternatives cannot become the primary', async () => {
  const { service, choices } = harness();
  await service.get('alice');
  choices[0]!.status = 'configured_invalid';
  assert.equal((await service.get('alice')).defaults.resource, 'mteam');
  await assert.rejects(service.setDefault('alice', 'resource', 'mteam'), { code: 'INTEGRATION_DEFAULT_INVALID' });
  await assert.rejects(service.selectSites('alice', ['unknown']), { code: 'INTEGRATION_DEFAULT_INVALID' });
  await service.configured('alice', 'resource', 'hdarea');
  assert.equal((await service.get('alice')).defaults.resource, 'mteam');
});
test('deleting a primary requires an explicit replacement; deleting the last configuration clears its selection', async () => {
  const { service, choices } = harness();
  await service.get('alice');
  await assert.rejects(service.beforeDelete('alice', 'resource', 'mteam'), {
    code: 'INTEGRATION_DEFAULT_REPLACEMENT_REQUIRED',
  }
  );
  await service.setDefault('alice', 'resource', 'hdarea');
  await service.beforeDelete('alice', 'resource', 'mteam');
  choices[0]!.status = 'unconfigured';
  await service.selectSites('alice', ['hdarea']);
  await service.beforeDelete('alice', 'resource', 'hdarea');
  choices[1]!.status = 'unconfigured';
  await service.deleted('alice', 'resource', 'hdarea');
  assert.deepEqual((await service.get('alice')).effectiveSites, []);
});

test('the default stays enabled for legacy rows, explicit exclusions and newly selected defaults', async () => {
  const { service, rows } = harness();
  rows.set('alice', { defaults: { resource: 'mteam' }, selectedSites: ['hdarea'] });
  assert.deepEqual((await service.get('alice')).effectiveSites, ['hdarea', 'mteam']);
  const selected = await service.selectSites('alice', ['hdarea']);
  assert.ok(selected.selectedSites.includes('mteam'));
  const changed = await service.setDefault('alice', 'resource', 'hdarea');
  assert.ok(changed.effectiveSites.includes('hdarea'));
  assert.ok(changed.effectiveSites.includes('mteam'));
  assert.deepEqual((await service.selectSites('alice', [])).effectiveSites, ['hdarea']);
});
