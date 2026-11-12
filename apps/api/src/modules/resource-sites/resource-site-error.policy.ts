import type { ResourceSiteError } from './resource-site.errors.js';

export const RESOURCE_SITE_ERROR_STATUSES: ReadonlyMap<ResourceSiteError['reason'], number> = new Map([
  ['agentUnavailable', 503],
  ['agentUnsupported', 503],
  ['agentModeConflict', 409],
  ['notConfigured', 409],
  ['invalidCredential', 400],
  ['timeout', 504],
]);
