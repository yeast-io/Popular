import type { ResourceSiteError } from '../resource-sites/resource-site.errors.js';

export const AGENT_RESOURCE_ERROR_REASONS: ReadonlyMap<string, ResourceSiteError['reason']> = new Map([
  ['AGENT_SITE_API_KEY_REQUIRED', 'apiKeyRequired'],
  ['AGENT_SITE_DOWNLOAD_EXPIRED', 'downloadExpired'],
  ['AGENT_SITE_AUTHENTICATION', 'authentication'],
  ['AGENT_SITE_ACCOUNT_CHANGED', 'authentication'],
  ['AGENT_SITE_NOT_CONFIGURED', 'notConfigured'],
  ['AGENT_SITE_BLOCKED', 'blocked'],
  ['AGENT_SITE_RATE_LIMITED', 'rateLimited'],
  ['AGENT_RESOURCE_BUSY', 'rateLimited'],
  ['AGENT_RESOURCE_TIMEOUT', 'timeout'],
  ['AGENT_SITE_TIMEOUT', 'timeout'],
  ['AGENT_RESOURCE_UNSUPPORTED', 'agentUnsupported'],
  ['AGENT_SITE_UNSUPPORTED', 'agentUnsupported'],
  ['AGENT_SITE_TARGET_CHANGED', 'agentModeConflict'],
  ['AGENT_SITE_DOWNLOAD_LIMITED', 'downloadLimited'],
  ['AGENT_RESOURCE_INVALID_RESPONSE', 'invalidResponse'],
  ['AGENT_SITE_INVALID_RESPONSE', 'invalidResponse'],
  ['AGENT_SITE_REDIRECTED', 'redirected'],
]);
