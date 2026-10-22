import { AppError } from '../../infrastructure/http/app-error.js';
import { siteAccountMessages } from './site-account.messages.js';

export function siteAccountInUse(cause: unknown): AppError {
  return new AppError(409, 'RESOURCE_SITE_ACCOUNT_IN_USE', siteAccountMessages.en.inUse, undefined, { cause });
}

export function siteAccountIdentityPending(): AppError {
  return new AppError(503, 'RESOURCE_SITE_IDENTITY_PENDING', siteAccountMessages.en.pending);
}

export function localizeSiteAccountError(error: unknown, language?: string): void {
  if (!(error instanceof AppError) || !language?.startsWith('zh')) return;
  if (error.code === 'RESOURCE_SITE_ACCOUNT_IN_USE') error.message = siteAccountMessages.zh.inUse;
  if (error.code === 'RESOURCE_SITE_IDENTITY_PENDING') error.message = siteAccountMessages.zh.pending;
}
