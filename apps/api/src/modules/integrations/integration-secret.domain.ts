import {
  MASKED_INTEGRATION_SECRET,
  INTEGRATION_SECRET_MASK_CHARACTER,
  maskIntegrationSecret,
} from '@movie-hub/contract';
import { integrationSecretMessages } from './integration-secret.messages.js';
import { AppError } from '../../infrastructure/http/app-error.js';

/** Omitted and unchanged display markers retain the saved credential under existing identity checks. */
export function replacementSecret(value: string | undefined, existing?: string): string | undefined {
  if (
    !value
    || value === MASKED_INTEGRATION_SECRET
    || (existing !== undefined && value === maskIntegrationSecret(existing))
  )
    return undefined;
  if (value.includes(INTEGRATION_SECRET_MASK_CHARACTER))
    throw new AppError(400, 'VALIDATION_ERROR', integrationSecretMessages.en);
  return value;
}
