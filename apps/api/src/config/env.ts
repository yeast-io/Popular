import { EnvSchema, TrendingEnvSchema, MigrationEnvSchema } from './env.schema.js';
import type { AppConfig, TrendingConfig, MigrationConfig } from './env.schema.js';

export class InvalidEnvironmentError extends Error {
  constructor(
    public readonly issues: string[]
  ) {
    super(`Invalid environment:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'InvalidEnvironmentError';
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(environment);
  if (!parsed.success) {
    throw new InvalidEnvironmentError(
      parsed.error.issues.map((issue) => {
        return `${issue.path.join('.') || 'environment'}: ${issue.message}`;
      }),
    );
  }

  const trustProxy = parseTrustProxy(parsed.data.TRUST_PROXY);
  return { ...parsed.data, trustProxy };
}

export function loadTrendingConfig(environment: NodeJS.ProcessEnv = process.env): TrendingConfig {
  const parsed = TrendingEnvSchema.safeParse(environment);
  if (!parsed.success) {
    throw new InvalidEnvironmentError(
      parsed.error.issues.map((issue) => {
        return `${issue.path.join('.') || 'environment'}: ${issue.message}`;
      }),
    );
  }
  return parsed.data;
}

export function loadMigrationConfig(environment: NodeJS.ProcessEnv = process.env): MigrationConfig {
  const parsed = MigrationEnvSchema.safeParse(environment);
  if (!parsed.success) {
    throw new InvalidEnvironmentError(
      parsed.error.issues.map((issue) => {
        return `${issue.path.join('.') || 'environment'}: ${issue.message}`;
      }),
    );
  }
  return parsed.data;
}

function parseTrustProxy(value: string): false | string[] {
  if (value === 'true')
    throw new InvalidEnvironmentError([
      'TRUST_PROXY: true trusts every proxy; provide explicit trusted addresses or CIDR ranges',
    ]);
  if (value === 'false') return false;
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0)
    throw new InvalidEnvironmentError(['TRUST_PROXY: must be true, false, or a comma-separated allowlist']);
  return entries;
}

export const notificationTestEnabled = (config: Pick<AppConfig, 'NODE_ENV'>): boolean => {
  return ['development', 'test', 'local', 'dev'].includes(config.NODE_ENV);
};

/** Experimental pages are available only in the project's test/development environments. */
export const aiAssistantPageEnabled = (config: Pick<AppConfig, 'NODE_ENV' | 'PAGE_AI_ASSISTANT_ENABLED'>): boolean => {
  return notificationTestEnabled(config) && config.PAGE_AI_ASSISTANT_ENABLED === true;
};
export const docsPageEnabled = (config: Pick<AppConfig, 'NODE_ENV' | 'PAGE_DOCS_ENABLED'>): boolean => {
  return notificationTestEnabled(config) && config.PAGE_DOCS_ENABLED === true;
};
