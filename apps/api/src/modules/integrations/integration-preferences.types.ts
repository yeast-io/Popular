import type { IntegrationCategory, IntegrationDefaults, IntegrationPreferences } from '@movie-hub/contract';

export interface IntegrationPreferencesRecord {
  defaults: IntegrationDefaults;
  selectedSites: string[];
  resourceAgentDeviceId?: string;
  resourceExecutionId?: string;
  agentSelectedSites?: string[];
  agentDefaultSite?: string;
}
export interface IntegrationPreferencesStore {
  setResourceAgent?(ownerId: string, deviceId: string | null, sites: string[]): Promise<void>;
  selectAgentSites?(ownerId: string, sites: string[]): Promise<void>;
  setAgentDefault?(ownerId: string, id: string): Promise<void>;
  read(ownerId: string): Promise<IntegrationPreferencesRecord>;
  setDefault(ownerId: string, category: IntegrationCategory, id: string, onlyIfMissing?: boolean): Promise<void>;
  selectSites(ownerId: string, sites: string[]): Promise<void>;
  remove(ownerId: string, category: IntegrationCategory, id: string): Promise<void>;
}
export type IntegrationChoice = IntegrationPreferences['choices'][number];
export type IntegrationChoicesReader = (ownerId: string) => Promise<IntegrationChoice[]>;
