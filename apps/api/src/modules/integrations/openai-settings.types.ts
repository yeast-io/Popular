import type { OpenAIValidation } from '@movie-hub/contract';

export interface OpenAIConfigRecord {
  ownerId: string;
  encryptedApiKey: string;
  maskedApiKey: string;
  model?: string;
  validation?: OpenAIValidation;
}

export interface OpenAIConfigStore {
  find(ownerId: string): Promise<OpenAIConfigRecord | null>;
  save(record: OpenAIConfigRecord, expectedEncryptedApiKey: string | null): Promise<boolean>;
  delete(ownerId: string): Promise<void>;
  selectModel(ownerId: string, encryptedApiKey: string, model: string): Promise<boolean>;
  saveValidation(ownerId: string, encryptedApiKey: string, validation: OpenAIValidation): Promise<boolean>;
}

export interface OpenAIVerification {
  model: string;
  recommendedModels?: readonly string[];
  verify(apiKey: string): Promise<string[]>;
}

export interface OpenAICredentials {
  apiKey: string;
  model: string;
}
