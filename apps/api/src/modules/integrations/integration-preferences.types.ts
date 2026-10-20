import type { IntegrationCategory, IntegrationDefaults, IntegrationPreferences } from '@movie-hub/contract';

export interface IntegrationPreferencesRecord {
  defaults: IntegrationDefaults;
  selectedSites: string[];
}
export interface IntegrationPreferencesStore {
  read(ownerId: string): Promise<IntegrationPreferencesRecord>;
  setDefault(ownerId: string, category: IntegrationCategory, id: string, onlyIfMissing?: boolean): Promise<void>;
  selectSites(ownerId: string, sites: string[]): Promise<void>;
  remove(ownerId: string, category: IntegrationCategory, id: string): Promise<void>;
}
export type IntegrationChoice = IntegrationPreferences['choices'][number];
export type IntegrationChoicesReader = (ownerId: string) => Promise<IntegrationChoice[]>;
