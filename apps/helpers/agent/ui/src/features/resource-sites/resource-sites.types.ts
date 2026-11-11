import type { SecretChange } from '../../settings.types';

export type ResourceSite = 'mteam' | 'hdarea' | 'hdwing';
export interface ResourceSiteSnapshot {
  site: ResourceSite;
  baseUrl: string;
  enabled: boolean;
  status: 'unconfigured' | 'configured_valid' | 'configured_invalid';
  hasCredential: boolean;
  hasPasskey: boolean;
  requiresPasskey: boolean;
  verifiedAt: number | null;
  lastError: string | null;
}
export interface ResourceSiteRequest {
  site: ResourceSite;
  baseUrl: string;
  credential: SecretChange;
  passkey: SecretChange;
}
export interface ResourceSiteClient {
  list(): Promise<ResourceSiteSnapshot[]>;
  configure(input: ResourceSiteRequest): Promise<ResourceSiteSnapshot>;
  verify(site: ResourceSite): Promise<ResourceSiteSnapshot>;
  setEnabled(site: ResourceSite, enabled: boolean): Promise<ResourceSiteSnapshot>;
  remove(site: ResourceSite): Promise<void>;
}
export interface ResourceSiteEntry {
  snapshot: ResourceSiteSnapshot;
  baseUrl: string;
  credential: string;
  passkey: string;
  editing: boolean;
  confirmingDelete: boolean;
  busy: boolean;
  error: string;
}
