import type { AiSettingsService } from './ai-settings.service.js';
import type { AiProvider, AiValidation } from '@movie-hub/contract';

export interface AiConfigRecord {
  revision?: number;
  encryptionContextVersion?: number;
  ownerId: string;
  encryptedApiKey: string;
  maskedApiKey: string;
  model?: string;
  validation?: AiValidation;
}

export interface AiConfigStore {
  find(ownerId: string): Promise<AiConfigRecord | null>;
  save(record: AiConfigRecord, expectedEncryptedApiKey: string | null): Promise<boolean>;
  delete(ownerId: string): Promise<void>;
  selectModel(ownerId: string, encryptedApiKey: string, model: string, expectedRevision?: number): Promise<boolean>;
  saveValidation(ownerId: string, encryptedApiKey: string, validation: AiValidation, expectedRevision?: number): Promise<boolean>;
}

export interface AiVerification {
  model: string;
  recommendedModels?: readonly string[];
  verify(apiKey: string): Promise<string[]>;
}

export interface AiCredentials {
  apiKey: string;
  model: string;
}

export type AiSettingsRegistry = Record<AiProvider, AiSettingsService>;
