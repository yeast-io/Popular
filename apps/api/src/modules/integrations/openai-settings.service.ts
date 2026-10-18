import { currentAiTrace, aiStep } from '../../infrastructure/logging/ai-trace.js';
import type { OpenAIConfiguration, OpenAIValidation } from '@movie-hub/contract';
import type { AuthService } from '../auth/auth.service.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { SecretCrypto } from './secret-crypto.js';

export interface OpenAIConfigRecord {
  ownerId: string;
  encryptedApiKey: string;
  maskedApiKey: string;
  model?: string;
  validation?: OpenAIValidation;
}
export interface OpenAIConfigStore {
  find(ownerId: string): Promise<OpenAIConfigRecord | null>;
  save(record: OpenAIConfigRecord): Promise<void>;
  delete(ownerId: string): Promise<void>;
  selectModel(ownerId: string, encryptedApiKey: string, model: string): Promise<boolean>;
  saveValidation(ownerId: string, encryptedApiKey: string, validation: OpenAIValidation): Promise<boolean>;
}
export class OpenAIProbeError extends Error {
  constructor(
    readonly reason: NonNullable<OpenAIValidation['failureReason']>
  ) {
    super('OpenAI connection verification failed');
  }
}
export class OpenAISettingsService {
  private readonly pending = new Map<string, Promise<OpenAIConfiguration>>();
  private readonly lastAttempt = new Map<string, number>();
  constructor(
    private readonly auth: Pick<AuthService, 'requireOwnerId'>,
    private readonly store: OpenAIConfigStore,
    private readonly secrets: SecretCrypto,
    private readonly verification?: { model: string; recommendedModels?: readonly string[]; verify(apiKey: string): Promise<string[]> }
  ) {}

  async get(token: string | undefined): Promise<OpenAIConfiguration> {
    const record = await this.store.find(await this.auth.requireOwnerId(token));
    return record ? this.response(record) : { configured: false };
  }

  async save(token: string | undefined, apiKey: string): Promise<OpenAIConfiguration> {
    const ownerId = await this.auth.requireOwnerId(token);
    const key = apiKey.trim();
    if (key.length < 20 || key.length > 4096 || /\s/.test(key)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid API key format');
    }
    const maskedApiKey = `••••${key.slice(-4)}`;
    await this.store.save({ ownerId, maskedApiKey, encryptedApiKey: this.secrets.encrypt(key, this.context(ownerId)) });
    return this.response({ ownerId, encryptedApiKey: '', maskedApiKey });
  }

  private response(record: OpenAIConfigRecord): OpenAIConfiguration {
    const model = record.model ?? this.verification?.model;
    return { configured: true, maskedApiKey: record.maskedApiKey,
      ...(model ? { model } : {}),
      ...(record.validation && record.validation.method === 'model_list'
        ? { validation: { ...record.validation, models: this.recommendedModels(record.validation.models) } } : {}),
    };
  }
  private recommendedModels(available: readonly string[]): string[] {
    const recommended = this.verification?.recommendedModels;
    return recommended ? [...new Set(recommended)].filter(model => available.includes(model)) : [...available];
  }

  async test(token: string | undefined): Promise<OpenAIConfiguration> {
    const ownerId = await this.auth.requireOwnerId(token);
    const existing = this.pending.get(ownerId);
    if (existing) return existing;
    const operation = this.verify(ownerId);
    this.pending.set(ownerId, operation);
    try { return await operation; } finally { if (this.pending.get(ownerId) === operation) this.pending.delete(ownerId); }
  }
  private async verify(ownerId: string): Promise<OpenAIConfiguration> {
    const record = await this.store.find(ownerId);
    if (!record) throw new AppError(403, 'OPENAI_NOT_CONFIGURED', 'Save an API key before testing');
    if (!this.verification) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Connection verification is unavailable');
    if (Date.now() - (this.lastAttempt.get(ownerId) ?? 0) < 30_000) throw new AppError(409, 'CONFLICT', 'Wait 30 seconds before another connection test');
    const key = this.secrets.decrypt(record.encryptedApiKey, this.context(ownerId));
    this.lastAttempt.set(ownerId, Date.now());
    let validation: OpenAIValidation;
    try {
      const models = await this.verification.verify(key);
      validation = { method: 'model_list', status: 'valid', checkedAt: new Date().toISOString(), models };
    } catch (error) {
      validation = { method: 'model_list', status: 'failed', checkedAt: new Date().toISOString(), models: [],
        failureReason: error instanceof OpenAIProbeError ? error.reason : 'request_failed' };
    }
    if (!await this.store.saveValidation(ownerId, record.encryptedApiKey, validation)) {
      throw new AppError(409, 'CONFLICT', 'API key changed during testing; test the current key again');
    }
    return this.response({ ...record, validation });
  }

  async selectModel(token: string | undefined, model: string): Promise<OpenAIConfiguration> {
    const ownerId = await this.auth.requireOwnerId(token);
    const record = await this.store.find(ownerId);
    if (!record) throw new AppError(403, 'OPENAI_NOT_CONFIGURED', 'Save an API key before choosing a model');
    if (record.validation?.method !== 'model_list' || record.validation.status !== 'valid' || !this.recommendedModels(record.validation.models).includes(model)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Test the current key and choose a model from its list');
    }
    if (!await this.store.selectModel(ownerId, record.encryptedApiKey, model)) {
      throw new AppError(409, 'CONFLICT', 'API key or model list changed; reload settings');
    }
    return this.response({ ...record, model });
  }

  async requireCredentials(ownerId: string): Promise<{ apiKey: string; model: string }> {
    const record = await aiStep('credentials.load', () => this.store.find(ownerId));
    if (!record) throw new AppError(403, 'OPENAI_NOT_CONFIGURED', 'Configure your OpenAI API key in Settings first');
    const model = record.model ?? this.verification?.model;
    if (!model) throw new AppError(400, 'VALIDATION_ERROR', 'Choose an OpenAI model in Settings first');
    const apiKey = await aiStep('credentials.decrypt', async () => this.secrets.decrypt(record.encryptedApiKey, this.context(ownerId)));
    currentAiTrace()?.sensitive(apiKey);
    return { apiKey, model };
  }

  async delete(token: string | undefined): Promise<void> {
    await this.store.delete(await this.auth.requireOwnerId(token));
  }

  async requireApiKey(ownerId: string): Promise<string> {
    const record = await aiStep('credentials.load', () => this.store.find(ownerId));
    if (!record) throw new AppError(403, 'OPENAI_NOT_CONFIGURED', 'Configure your OpenAI API key in Settings first');
    const key = await aiStep('credentials.decrypt', async () => this.secrets.decrypt(record.encryptedApiKey, this.context(ownerId)));
    currentAiTrace()?.sensitive(key);
    return key;
  }

  private context(ownerId: string): string {
    return `movie-hub:integration:openai:owner:${ownerId}`;
  }
}
