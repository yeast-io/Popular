import type { SecretChange } from '../../settings.types';

export type ResourceSite = 'mteam' | 'hdarea' | 'hdwing';
export interface ResourceSiteSnapshot {
  site: ResourceSite;
  isDefault?: boolean;
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
}
export interface ResourceSiteClient {
  list(): Promise<ResourceSiteSnapshot[]>;
  setDefault?(site: ResourceSite): Promise<ResourceSiteSnapshot[]>;
  configure(input: ResourceSiteRequest): Promise<ResourceSiteSnapshot>;
  verify(site: ResourceSite): Promise<ResourceSiteSnapshot>;
  setEnabled(site: ResourceSite, enabled: boolean): Promise<ResourceSiteSnapshot>;
  remove(site: ResourceSite): Promise<void>;
}
export interface ResourceSiteEntry {
  snapshot: ResourceSiteSnapshot;
  baseUrl: string;
  credential: string;
  editing: boolean;
  confirmingDelete: boolean;
  busy: boolean;
  error: string;
}
