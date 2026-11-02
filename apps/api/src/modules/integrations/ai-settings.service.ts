import { AiApiKeySchema } from './ai-settings.schema.js';
import { aiSettingsMessages as messages } from './ai-settings.messages.js';
import type { IntegrationPreferencesService } from './integration-preferences.service.js';
import type { AiConfigRecord, AiConfigStore, AiVerification, AiCredentials } from './ai-settings.types.js';
import { currentAiTrace, aiStep } from '../../infrastructure/logging/ai-trace.js';
import type { AiProvider, AiConfiguration, AiValidation } from '@movie-hub/contract';
import type { AuthService } from '../auth/auth.service.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { SecretCrypto } from './secret-crypto.js';

export class AiProbeError extends Error {
  constructor(readonly reason: NonNullable<AiValidation['failureReason']>, options?: ErrorOptions) {
    super('Ai connection verification failed', options);
  }
}
export class AiSettingsService {
  preferences?: IntegrationPreferencesService;
  private readonly pending = new Map<string, Promise<AiConfiguration>>();

  constructor(
    private readonly auth: Pick<AuthService, 'requireOwnerId'>,
    private readonly store: AiConfigStore,
    private readonly secrets: SecretCrypto,
    private readonly verification?: AiVerification,
    private readonly provider: AiProvider = 'openai'
  ) {}

  async get(token: string | undefined): Promise<AiConfiguration> {
    const ownerId = await aiStep(`${this.provider}.authenticate`, () => this.auth.requireOwnerId(token));
    const record = await aiStep(`${this.provider}.credentials.load`, () => this.store.find(ownerId));
    return record ? this.response(record) : { configured: false, provider: this.provider };
  }

  async save(token: string | undefined, apiKey: string): Promise<AiConfiguration> {
    const ownerId = await aiStep(`${this.provider}.authenticate`, () => this.auth.requireOwnerId(token));
    const parsed = AiApiKeySchema.safeParse(apiKey);
    if (!parsed.success) {
      throw new AppError(400, 'VALIDATION_ERROR', messages.invalidKey.en);
    }
    const key = parsed.data;
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

  private async verifyAndSave(ownerId: string, key: string): Promise<AiConfiguration> {
    const previous = await aiStep(`${this.provider}.credentials.load`, () => this.store.find(ownerId));
    const validation = await this.probe(ownerId, key);
    if (validation.status !== 'valid') {
      throw new AppError(400, 'INTEGRATION_VALIDATION_FAILED', messages.failed.en,
        { provider: this.provider, reason: validation.failureReason });
    }
    const available = this.recommendedModels(validation.models);
    const previousModel = previous?.model ?? this.verification?.model;
    const model = previousModel && available.includes(previousModel) ? previousModel : available[0];
    const record: AiConfigRecord = {
      ownerId, maskedApiKey: `••••${key.slice(-4)}`,
      encryptedApiKey: this.secrets.encrypt(key, this.context(ownerId)),
      validation, ...(model ? { model } : {}),
      ...(previous?.revision === undefined ? {} : { revision: previous.revision }),
    };
    if (!(await aiStep(`${this.provider}.credentials.save`, () => this.store.save(record, previous?.encryptedApiKey ?? null)))) {
      throw new AppError(409, 'CONFLICT', messages.changed.en);
    }
    if (model) await this.preferences?.configured(ownerId, 'ai', this.provider);
    return this.response(record);
  }

  private async probe(ownerId: string, key: string): Promise<AiValidation> {
    if (!this.verification) throw new AppError(503, 'SERVICE_UNAVAILABLE', messages.unavailable.en);
    currentAiTrace()?.sensitive(key);
    try {
      const models = await aiStep(`${this.provider}.models.list`, () => this.verification!.verify(key));
      return { method: 'model_list', status: 'valid', checkedAt: new Date().toISOString(), models };
    } catch (error) {
      currentAiTrace()?.fail(error);
      currentAiTrace()?.clearFailure();
      return {
        method: 'model_list', status: 'failed', checkedAt: new Date().toISOString(), models: [],
        failureReason: error instanceof AiProbeError ? error.reason : 'request_failed',
      };
    }
  }

  private response(record: AiConfigRecord): AiConfiguration {
    const model = record.model ?? this.verification?.model;
    return {
      configured: true,
      provider: this.provider,
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

  async test(token: string | undefined): Promise<AiConfiguration> {
    const ownerId = await aiStep(`${this.provider}.authenticate`, () => this.auth.requireOwnerId(token));
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

  private async verify(ownerId: string): Promise<AiConfiguration> {
    const record = await aiStep(`${this.provider}.credentials.load`, () => this.store.find(ownerId));
    if (!record) throw new AppError(403, 'AI_NOT_CONFIGURED', messages.missing.en);
    const key = this.secrets.decrypt(record.encryptedApiKey, this.context(ownerId));
    const validation = await this.probe(ownerId, key);
    if (!(await aiStep(`${this.provider}.validation.save`, () => this.store.saveValidation(ownerId, record.encryptedApiKey, validation, record.revision)))) {
      throw new AppError(409, 'CONFLICT', messages.testChanged.en);
    }
    if (validation.status === 'valid') await this.preferences?.configured(ownerId, 'ai', this.provider);
    return this.response({ ...record, validation });
  }

  async selectModel(token: string | undefined, model: string): Promise<AiConfiguration> {
    const ownerId = await aiStep(`${this.provider}.authenticate`, () => this.auth.requireOwnerId(token));
    const record = await aiStep(`${this.provider}.credentials.load`, () => this.store.find(ownerId));
    if (!record) throw new AppError(403, 'AI_NOT_CONFIGURED', messages.modelMissing.en);
    if (
      record.validation?.method !== 'model_list'
      || record.validation.status !== 'valid'
      || !this.recommendedModels(record.validation.models).includes(model)
    ) {
      throw new AppError(400, 'VALIDATION_ERROR', messages.modelInvalid.en);
    }
    if (!(await aiStep(`${this.provider}.model.save`, () => this.store.selectModel(ownerId, record.encryptedApiKey, model, record.revision)))) {
      throw new AppError(409, 'CONFLICT', messages.modelChanged.en);
    }
    return this.response({ ...record, model });
  }

  async requireCredentials(ownerId: string): Promise<AiCredentials> {
    const record = await aiStep('credentials.load', () => this.store.find(ownerId));
    if (!record) throw new AppError(403, 'AI_NOT_CONFIGURED', messages.configure.en);
    const model = record.model ?? this.verification?.model;
    if (!model) throw new AppError(400, 'VALIDATION_ERROR', messages.chooseModel.en);
    const apiKey = await aiStep('credentials.decrypt', async () => {
      return this.secrets.decrypt(record.encryptedApiKey, this.context(ownerId));
    });
    currentAiTrace()?.sensitive(apiKey);
    return { apiKey, model };
  }

  async delete(token: string | undefined): Promise<void> {
    const ownerId = await aiStep(`${this.provider}.authenticate`, () => this.auth.requireOwnerId(token));
    await this.preferences?.beforeDelete(ownerId, 'ai', this.provider);
    await aiStep(`${this.provider}.credentials.delete`, () => this.store.delete(ownerId));
    await this.preferences?.deleted(ownerId, 'ai', this.provider);
  }

  async requireApiKey(ownerId: string): Promise<string> {
    const record = await aiStep('credentials.load', () => this.store.find(ownerId));
    if (!record) throw new AppError(403, 'AI_NOT_CONFIGURED', messages.configure.en);
    const key = await aiStep('credentials.decrypt', async () => {
      return this.secrets.decrypt(record.encryptedApiKey, this.context(ownerId));
    });
    currentAiTrace()?.sensitive(key);
    return key;
  }

  private context(ownerId: string): string {
    return `movie-hub:integration:${this.provider}:owner:${ownerId}`;
  }
}
