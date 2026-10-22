import { AppError } from '../../infrastructure/http/app-error.js';
import { resourceSiteMessages } from './resource-site.messages.js';

export class ResourceSiteError extends AppError {
  constructor(public readonly reason: keyof typeof resourceSiteMessages.en, options?: ErrorOptions) {
    super(
      reason === 'notConfigured' ? 409 : reason === 'invalidCredential' ? 400 : reason === 'timeout' ? 504 : 502,
      reason === 'notConfigured' ? 'RESOURCE_SITE_NOT_CONFIGURED' : 'RESOURCE_SITE_FAILED',
      resourceSiteMessages.en[reason],
      { reason },
      options
    );
  }
}
