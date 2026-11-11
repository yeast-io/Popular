import type { ResourceSiteEntry } from './resource-sites.types';

export function sameSiteEndpoint(entry: ResourceSiteEntry): boolean {
  try {
    return new URL(entry.baseUrl).href === new URL(entry.snapshot.baseUrl).href;
  } catch {
    return false;
  }
}
export function canConfigureSite(entry: ResourceSiteEntry): boolean {
  const keep = sameSiteEndpoint(entry);
  return (
    !entry.busy
    && !!entry.baseUrl.trim()
    && (!!entry.credential.trim() || (keep && entry.snapshot.hasCredential))
  );
}
