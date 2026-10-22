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
      if (!record.defaults[category]) {
        const first = choices.find((choice) => choice.category === category && choice.status === 'configured_valid');
        if (first) await this.store.setDefault(ownerId, category, first.id, true);
      }
    }
    const current = await this.store.read(ownerId);
    const selectedSites = current.selectedSites.filter((id) => {
      return choices.some(
        (choice) => choice.category === 'resource' && choice.id === id && choice.status !== 'unconfigured'
      );
    });
    const effectiveSites = selectedSites.length
      ? selectedSites
      : current.defaults.resource
        ? [current.defaults.resource]
        : [];
    return { ...current, selectedSites, effectiveSites, choices };
  }

  async setDefault(ownerId: string, category: IntegrationCategory, id: string): Promise<IntegrationPreferences> {
    const choice = (await this.choices(ownerId)).find((item) => item.category === category && item.id === id);
    if (choice?.status !== 'configured_valid')
      throw new AppError(400, 'INTEGRATION_DEFAULT_INVALID', messages.en.invalid);
    await aiStep('integration-preferences.default.save', () => this.store.setDefault(ownerId, category, id));
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
    await aiStep('integration-preferences.selection.save', () => this.store.selectSites(ownerId, sites));
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
