import { AppError } from '../../infrastructure/http/app-error.js';
import { resourceSiteMessages } from './resource-site.messages.js';
import { RESOURCE_SITE_ERROR_STATUSES } from './resource-site-error.policy.js';

export class ResourceSiteError extends AppError {
  constructor(public readonly reason: keyof typeof resourceSiteMessages.en, options?: ErrorOptions) {
    super(
      RESOURCE_SITE_ERROR_STATUSES.get(reason) ?? 502,
      reason === 'notConfigured' ? 'RESOURCE_SITE_NOT_CONFIGURED' : 'RESOURCE_SITE_FAILED',
      resourceSiteMessages.en[reason],
      { reason },
      options
    );
  }
}
