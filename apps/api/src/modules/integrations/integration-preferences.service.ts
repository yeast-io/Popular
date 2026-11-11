import type { IntegrationCategory, IntegrationPreferences } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import { aiStep } from '../../infrastructure/logging/ai-trace.js';
import type { IntegrationChoicesReader, IntegrationPreferencesStore } from './integration-preferences.types.js';
import { integrationPreferencesMessages as messages } from './integration-preferences.messages.js';

export class IntegrationPreferencesService {
  constructor(private readonly store: IntegrationPreferencesStore, private readonly choices: IntegrationChoicesReader) {}

  async get(ownerId: string): Promise<IntegrationPreferences> {
    const choices = await aiStep('integration-preferences.choices', () => this.choices(ownerId));
    const record = await this.store.read(ownerId);
    for (const category of ['resource', 'downloader', 'ai'] as const) {
      if (category === 'resource' && record.resourceAgentDeviceId) continue;
      if (!record.defaults[category]) {
        const first = choices.find((choice) => choice.category === category && choice.status === 'configured_valid');
        if (first) await this.store.setDefault(ownerId, category, first.id, true);
      }
    }
    const current = await this.store.read(ownerId);
    const agent = !!current.resourceAgentDeviceId;
    const defaults = { ...current.defaults };
    if (agent) {
      const available = choices
        .filter((choice) => choice.category === 'resource' && choice.status !== 'unconfigured')
        .map((choice) => choice.id);
      const primary
        = current.agentDefaultSite && available.includes(current.agentDefaultSite)
          ? current.agentDefaultSite
          : available[0];
      if (primary) defaults.resource = primary;
      else delete defaults.resource;
    }
    const selectedSites = (agent ? (current.agentSelectedSites ?? []) : current.selectedSites).filter((id) => {
      return choices.some(
        (choice) => choice.category === 'resource' && choice.id === id && choice.status !== 'unconfigured'
      );
    });
    // The primary site participates even when an older selection omitted it.
    const effectiveSites = [...new Set([...selectedSites, ...(defaults.resource ? [defaults.resource] : [])])];
    return {
      defaults,
      selectedSites,
      effectiveSites,
      choices,
      ...(current.resourceAgentDeviceId ? { resourceAgentDeviceId: current.resourceAgentDeviceId } : {}),
    };
  }

  async setDefault(ownerId: string, category: IntegrationCategory, id: string): Promise<IntegrationPreferences> {
    const choice = (await this.choices(ownerId)).find((item) => item.category === category && item.id === id);
    if (choice?.status !== 'configured_valid')
      throw new AppError(400, 'INTEGRATION_DEFAULT_INVALID', messages.en.invalid);
    if (category === 'resource') {
      const previous = await this.get(ownerId);
      await aiStep('integration-preferences.selection.save', () => {
        return previous.resourceAgentDeviceId && this.store.selectAgentSites
          ? this.store.selectAgentSites(ownerId, [...new Set([...previous.effectiveSites, id])])
          : this.store.selectSites(ownerId, [...new Set([...previous.effectiveSites, id])]);
      });
    }
    const agent = category === 'resource' && (await this.store.read(ownerId)).resourceAgentDeviceId;
    await aiStep('integration-preferences.default.save', () =>
      agent && this.store.setAgentDefault
        ? this.store.setAgentDefault(ownerId, id)
        : this.store.setDefault(ownerId, category, id)
    );
    return this.get(ownerId);
  }

  async selectSites(ownerId: string, sites: string[]): Promise<IntegrationPreferences> {
    const choices = await this.choices(ownerId);
    if (
      sites.some((id) => {
        return !choices.some(
          (choice) => choice.category === 'resource' && choice.id === id && choice.status !== 'unconfigured'
        );
      })
    )
      throw new AppError(400, 'INTEGRATION_DEFAULT_INVALID', messages.en.invalid);
    const current = await this.get(ownerId);
    const enabled = [...new Set([...sites, ...(current.defaults.resource ? [current.defaults.resource] : [])])];
    await aiStep('integration-preferences.selection.save', () =>
      current.resourceAgentDeviceId && this.store.selectAgentSites
        ? this.store.selectAgentSites(ownerId, enabled)
        : this.store.selectSites(ownerId, enabled)
    );
    return this.get(ownerId);
  }

  async configured(ownerId: string, category: IntegrationCategory, id: string): Promise<void> {
    await this.store.setDefault(ownerId, category, id, true);
  }

  async beforeDelete(ownerId: string, category: IntegrationCategory, id: string): Promise<void> {
    const state = await this.get(ownerId);
    if (
      state.defaults[category] === id
      && state.choices.some((choice) => {
        return choice.category === category && choice.id !== id && choice.status !== 'unconfigured';
      })
    )
      throw new AppError(409, 'INTEGRATION_DEFAULT_REPLACEMENT_REQUIRED', messages.en.replacement);
  }

  async deleted(ownerId: string, category: IntegrationCategory, id: string): Promise<void> {
    await this.store.remove(ownerId, category, id);
  }
}
