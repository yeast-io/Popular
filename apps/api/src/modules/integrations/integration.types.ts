import type { IntegrationFailureType } from '@movie-hub/contract';
import type { ExternalRequestContext } from '../external-usage/external-usage.types.js';

export interface IntegrationConfigRecord {
  ownerId: string;
  provider: 'mteam';
  baseUrl: string;
  webBaseUrl?: string;
  encryptedApiKey: string;
  externalUserId?: string;
  verifiedAt?: Date;
  lastValidationAt?: Date;
  lastFailureType?: IntegrationFailureType;
}

export interface IntegrationConfigStore {
  find(ownerId: string, provider: 'mteam'): Promise<IntegrationConfigRecord | null>;
  saveVerified(
    input: IntegrationConfigRecord & { externalUserId: string; verifiedAt: Date; lastValidationAt: Date },
  ): Promise<IntegrationConfigRecord>;
  recordFailure(
    ownerId: string,
    provider: 'mteam',
    attemptedAt: Date,
    failureType: IntegrationFailureType,
  ): Promise<void>;
  delete(ownerId: string, provider: 'mteam'): Promise<void>;
}

export interface MTeamVerifier {
  verify(baseUrl: string, apiKey: string, context?: ExternalRequestContext): Promise<string>;
}

export interface MTeamEndpoints {
  baseUrl: string;
  webBaseUrl: string;
}
