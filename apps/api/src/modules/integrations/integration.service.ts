import {
  type IntegrationFailureType,
  type MTeamConfiguration,
  type SaveMTeamConfigurationRequest,
} from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { AuthService } from '../auth/auth.service.js';
import type { IntegrationConfigRecord, IntegrationConfigStore, MTeamVerifier } from './integration.types.js';
import { SecretCrypto } from './secret-crypto.js';

export class IntegrationValidationError extends Error {
  constructor(
    public readonly failureType: IntegrationFailureType | 'permission' | 'rate_limited',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'IntegrationValidationError';
  }
}

export class IntegrationService {
  constructor(
    private readonly auth: AuthService,
    private readonly configs: IntegrationConfigStore,
    private readonly mteam: MTeamVerifier,
    private readonly secrets: SecretCrypto,
    private readonly allowedMTeamHosts: ReadonlySet<string>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getMTeam(token: string | undefined): Promise<MTeamConfiguration> {
    const ownerId = await this.auth.requireOwnerId(token);
    return toResponse(await this.configs.find(ownerId, 'mteam'));
  }

  async saveMTeam(token: string | undefined, input: SaveMTeamConfigurationRequest): Promise<MTeamConfiguration> {
    const ownerId = await this.auth.requireOwnerId(token);
    const baseUrl = normalizeMTeamBaseUrl(input.baseUrl, this.allowedMTeamHosts);
    const existing = await this.configs.find(ownerId, 'mteam');
    const secretContext = integrationSecretContext(ownerId, 'mteam');
    const apiKey = input.apiKey?.trim() || (existing ? this.secrets.decrypt(existing.encryptedApiKey, secretContext) : '');
    if (!apiKey) throw new AppError(400, 'VALIDATION_ERROR', 'M-Team API key is required for the first configuration');
    const attemptedAt = this.now();

    try {
      await this.mteam.verify(baseUrl, apiKey);
    } catch (error) {
      const failureType = error instanceof IntegrationValidationError
        ? error.failureType === 'permission' || error.failureType === 'rate_limited' ? 'remote_error' : error.failureType
        : 'network';
      await this.configs.recordFailure(ownerId, 'mteam', attemptedAt, failureType);
      throw new AppError(502, 'INTEGRATION_VALIDATION_FAILED', 'M-Team validation failed', { failureType });
    }

    const saved = await this.configs.saveVerified({
      ownerId,
      provider: 'mteam',
      baseUrl,
      encryptedApiKey: this.secrets.encrypt(apiKey, secretContext),
      verifiedAt: attemptedAt,
      lastValidationAt: attemptedAt,
    });
    return toResponse(saved);
  }

  async retestMTeam(token: string | undefined): Promise<MTeamConfiguration> {
    const ownerId = await this.auth.requireOwnerId(token);
    const existing = await this.configs.find(ownerId, 'mteam');
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'M-Team is not configured');
    const attemptedAt = this.now();

    try {
      await this.mteam.verify(
        existing.baseUrl,
        this.secrets.decrypt(existing.encryptedApiKey, integrationSecretContext(ownerId, 'mteam')),
      );
    } catch (error) {
      const failureType = error instanceof IntegrationValidationError
        ? error.failureType === 'permission' || error.failureType === 'rate_limited' ? 'remote_error' : error.failureType
        : 'network';
      await this.configs.recordFailure(ownerId, 'mteam', attemptedAt, failureType);
      throw new AppError(502, 'INTEGRATION_VALIDATION_FAILED', 'M-Team validation failed', { failureType });
    }

    const saved = await this.configs.saveVerified({ ...existing, verifiedAt: attemptedAt, lastValidationAt: attemptedAt });
    return toResponse(saved);
  }

  async deleteMTeam(token: string | undefined): Promise<void> {
    const ownerId = await this.auth.requireOwnerId(token);
    await this.configs.delete(ownerId, 'mteam');
  }
}

export function integrationSecretContext(ownerId: string, provider: 'mteam'): string {
  return `movie-hub:integration:${provider}:owner:${ownerId}`;
}

export function normalizeMTeamBaseUrl(raw: string, allowedHosts: ReadonlySet<string>): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'M-Team Base URL is invalid');
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') throw new AppError(400, 'VALIDATION_ERROR', 'M-Team Base URL must use HTTPS');
  if (url.username || url.password) throw new AppError(400, 'VALIDATION_ERROR', 'M-Team Base URL cannot contain credentials');
  if (url.search || url.hash) throw new AppError(400, 'VALIDATION_ERROR', 'M-Team Base URL cannot contain a query or fragment');
  if (url.port && url.port !== '443') throw new AppError(400, 'VALIDATION_ERROR', 'M-Team Base URL must use the default HTTPS port');
  if (!allowedHosts.has(hostname)) throw new AppError(400, 'VALIDATION_ERROR', 'M-Team Base URL host is not allowed');
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname && pathname !== '/api') throw new AppError(400, 'VALIDATION_ERROR', 'M-Team Base URL path must be empty or /api');
  return `${url.protocol}//${hostname}${pathname}`;
}

function toResponse(record: IntegrationConfigRecord | null): MTeamConfiguration {
  if (!record) return { provider: 'mteam', status: 'unconfigured' };
  const status = record.lastFailureType
    ? 'configured_invalid'
    : record.verifiedAt ? 'configured_valid' : 'configured_unverified';
  return {
    provider: 'mteam',
    status,
    baseUrl: record.baseUrl,
    ...(record.lastValidationAt ? { lastValidationAt: record.lastValidationAt.toISOString() } : {}),
    ...(record.lastFailureType ? { lastFailureType: record.lastFailureType } : {}),
  };
}
