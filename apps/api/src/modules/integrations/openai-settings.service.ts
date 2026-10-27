import { openAISettingsMessages as messages } from './openai-settings.messages.js';
import type { IntegrationPreferencesService } from './integration-preferences.service.js';
import type { OpenAIConfigRecord, OpenAIConfigStore, OpenAIVerification, OpenAICredentials } from './openai-settings.types.js';
import { currentAiTrace, aiStep } from '../../infrastructure/logging/ai-trace.js';
import type { OpenAIConfiguration, OpenAIValidation } from '@movie-hub/contract';
import type { AuthService } from '../auth/auth.service.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { SecretCrypto } from './secret-crypto.js';

export class OpenAIProbeError extends Error {
  constructor(readonly reason: NonNullable<OpenAIValidation['failureReason']>, options?: ErrorOptions) {
    super('OpenAI connection verification failed', options);
  }
}
export class OpenAISettingsService {
  preferences?: IntegrationPreferencesService;
  private readonly pending = new Map<string, Promise<OpenAIConfiguration>>();
  private readonly lastAttempt = new Map<string, number>();

  constructor(
    private readonly auth: Pick<AuthService, 'requireOwnerId'>,
    private readonly store: OpenAIConfigStore,
    private readonly secrets: SecretCrypto,
    private readonly verification?: OpenAIVerification
  ) {}

  async get(token: string | undefined): Promise<OpenAIConfiguration> {
    const ownerId = await aiStep('openai.authenticate', () => this.auth.requireOwnerId(token));
    const record = await aiStep('openai.credentials.load', () => this.store.find(ownerId));
    return record ? this.response(record) : { configured: false };
  }

  async save(token: string | undefined, apiKey: string): Promise<OpenAIConfiguration> {
    const ownerId = await aiStep('openai.authenticate', () => this.auth.requireOwnerId(token));
    const key = apiKey.trim();
    if (key.length < 20 || key.length > 4096 || /\s/.test(key)) {
      throw new AppError(400, 'VALIDATION_ERROR', messages.invalidKey.en);
    }
    currentAiTrace()?.sensitive(key);
    if (this.pending.has(ownerId)) throw new AppError(409, 'CONFLICT', messages.busy.en);
    const operation = this.verifyAndSave(ownerId, key);
    this.pending.set(ownerId, operation);
    try {
      return await operation;
    } finally {
      if (this.pending.get(ownerId) === operation) this.pending.delete(ownerId);
    }
  }

  private async verifyAndSave(ownerId: string, key: string): Promise<OpenAIConfiguration> {
    const previous = await aiStep('openai.credentials.load', () => this.store.find(ownerId));
    const validation = await this.probe(ownerId, key);
    if (validation.status !== 'valid') {
      throw new AppError(400, 'INTEGRATION_VALIDATION_FAILED', messages.failed.en,
        { provider: 'openai', reason: validation.failureReason });
    }
    const available = this.recommendedModels(validation.models);
    const previousModel = previous?.model ?? this.verification?.model;
    const model = previousModel && available.includes(previousModel) ? previousModel : available[0];
    const record: OpenAIConfigRecord = {
      ownerId, maskedApiKey: `••••${key.slice(-4)}`,
      encryptedApiKey: this.secrets.encrypt(key, this.context(ownerId)),
      validation, ...(model ? { model } : {}),
    };
    if (!(await aiStep('openai.credentials.save', () => this.store.save(record, previous?.encryptedApiKey ?? null)))) {
      throw new AppError(409, 'CONFLICT', messages.changed.en);
    }
    await this.preferences?.configured(ownerId, 'ai', 'openai');
    return this.response(record);
  }

  private async probe(ownerId: string, key: string): Promise<OpenAIValidation> {
    if (!this.verification) throw new AppError(503, 'SERVICE_UNAVAILABLE', messages.unavailable.en);
    if (Date.now() - (this.lastAttempt.get(ownerId) ?? 0) < 30_000)
      throw new AppError(409, 'CONFLICT', messages.cooldown.en);
    this.lastAttempt.set(ownerId, Date.now());
    currentAiTrace()?.sensitive(key);
    try {
      const models = await aiStep('openai.models.list', () => this.verification!.verify(key));
      return { method: 'model_list', status: 'valid', checkedAt: new Date().toISOString(), models };
    } catch (error) {
      currentAiTrace()?.fail(error);
      currentAiTrace()?.clearFailure();
      return {
        method: 'model_list', status: 'failed', checkedAt: new Date().toISOString(), models: [],
        failureReason: error instanceof OpenAIProbeError ? error.reason : 'request_failed',
      };
    }
  }

  private response(record: OpenAIConfigRecord): OpenAIConfiguration {
    const model = record.model ?? this.verification?.model;
    return {
      configured: true,
      maskedApiKey: record.maskedApiKey,
      ...(record.validation?.status === 'valid' && model && (record.model || this.recommendedModels(record.validation.models).includes(model)) ? { model } : {}),
      ...(record.validation && record.validation.method === 'model_list'
        ? { validation: { ...record.validation, models: this.recommendedModels(record.validation.models) } }
        : {}),
    };
  }

  private recommendedModels(available: readonly string[]): string[] {
    const recommended = this.verification?.recommendedModels;
    return recommended
      ? [...new Set(recommended)].filter((model) => {
          return available.includes(model);
        })
      : [...available];
  }

  async test(token: string | undefined): Promise<OpenAIConfiguration> {
    const ownerId = await aiStep('openai.authenticate', () => this.auth.requireOwnerId(token));
    const existing = this.pending.get(ownerId);
    if (existing) return existing;
    const operation = this.verify(ownerId);
    this.pending.set(ownerId, operation);
    try {
      return await operation;
    } finally {
      if (this.pending.get(ownerId) === operation) this.pending.delete(ownerId);
    }
  }

  private async verify(ownerId: string): Promise<OpenAIConfiguration> {
    const record = await aiStep('openai.credentials.load', () => this.store.find(ownerId));
    if (!record) throw new AppError(403, 'OPENAI_NOT_CONFIGURED', messages.missing.en);
    const key = this.secrets.decrypt(record.encryptedApiKey, this.context(ownerId));
    const validation = await this.probe(ownerId, key);
    if (!(await aiStep('openai.validation.save', () => this.store.saveValidation(ownerId, record.encryptedApiKey, validation)))) {
      throw new AppError(409, 'CONFLICT', messages.testChanged.en);
    }
    if (validation.status === 'valid') await this.preferences?.configured(ownerId, 'ai', 'openai');
    return this.response({ ...record, validation });
  }

  async selectModel(token: string | undefined, model: string): Promise<OpenAIConfiguration> {
    const ownerId = await aiStep('openai.authenticate', () => this.auth.requireOwnerId(token));
    const record = await aiStep('openai.credentials.load', () => this.store.find(ownerId));
    if (!record) throw new AppError(403, 'OPENAI_NOT_CONFIGURED', messages.modelMissing.en);
    if (
      record.validation?.method !== 'model_list'
      || record.validation.status !== 'valid'
      || !this.recommendedModels(record.validation.models).includes(model)
    ) {
      throw new AppError(400, 'VALIDATION_ERROR', messages.modelInvalid.en);
    }
    if (!(await aiStep('openai.model.save', () => this.store.selectModel(ownerId, record.encryptedApiKey, model)))) {
      throw new AppError(409, 'CONFLICT', messages.modelChanged.en);
    }
    return this.response({ ...record, model });
  }

  async requireCredentials(ownerId: string): Promise<OpenAICredentials> {
    const record = await aiStep('credentials.load', () => this.store.find(ownerId));
    if (!record) throw new AppError(403, 'OPENAI_NOT_CONFIGURED', messages.configure.en);
    const model = record.model ?? this.verification?.model;
    if (!model) throw new AppError(400, 'VALIDATION_ERROR', messages.chooseModel.en);
    const apiKey = await aiStep('credentials.decrypt', async () => {
      return this.secrets.decrypt(record.encryptedApiKey, this.context(ownerId));
    });
    currentAiTrace()?.sensitive(apiKey);
    return { apiKey, model };
  }

  async delete(token: string | undefined): Promise<void> {
    const ownerId = await aiStep('openai.authenticate', () => this.auth.requireOwnerId(token));
    await this.preferences?.beforeDelete(ownerId, 'ai', 'openai');
    await aiStep('openai.credentials.delete', () => this.store.delete(ownerId));
    await this.preferences?.deleted(ownerId, 'ai', 'openai');
  }

  async requireApiKey(ownerId: string): Promise<string> {
    const record = await aiStep('credentials.load', () => this.store.find(ownerId));
    if (!record) throw new AppError(403, 'OPENAI_NOT_CONFIGURED', messages.configure.en);
    const key = await aiStep('credentials.decrypt', async () => {
      return this.secrets.decrypt(record.encryptedApiKey, this.context(ownerId));
    });
    currentAiTrace()?.sensitive(key);
    return key;
  }

  private context(ownerId: string): string {
    return `movie-hub:integration:openai:owner:${ownerId}`;
  }
}
