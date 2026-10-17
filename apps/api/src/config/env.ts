import { z } from 'zod';
import { supportedLocales } from '@movie-hub/contract';

const booleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const optionalUrl = z.string().url().optional().or(z.literal('').transform(() => undefined));

const mongodbFields = {
  MONGODB_URI: z.string().url().refine((url) => ['mongodb:', 'mongodb+srv:'].includes(new URL(url).protocol), 'must use mongodb:// or mongodb+srv://'),
  MONGODB_DB_NAME: z.string().regex(/^[^/\\. "*$<>:|?]+$/, 'contains characters MongoDB does not allow').default('movie_hub'),
};

const redisFields = {
  REDIS_URL: z.string().url().refine((url) => ['redis:', 'rediss:'].includes(new URL(url).protocol), 'must use redis:// or rediss://'),
  REDIS_KEY_PREFIX: z.string().min(1).default('movie_hub:'),
};

const trendingFields = {
  TMDB_READ_ACCESS_TOKEN: z.string().min(1),
  TMDB_LANGUAGE: z.enum(supportedLocales).default('zh-CN'),
  TMDB_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
  TRENDING_SYNC_PAGES: z.coerce.number().int().min(1).max(50).default(3),
  TRENDING_SYNC_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
  TRENDING_SYNC_LOCK_TTL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
};

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'local', 'dev', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  WEB_ORIGIN: z.string().url(),
  TRUST_PROXY: z.string().default('false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ACCESS_LOG_ENABLED: booleanString.default(true),
  ...mongodbFields,
  ...redisFields,
  SESSION_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default('movie_hub_session'),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(31_536_000).default(2_592_000),
  SESSION_TOKEN_PEPPER: z.string().min(32),
  SESSION_COOKIE_SECURE: booleanString.default(false),
  REGISTRATION_USER_LIMIT: z.coerce.number().int().min(1).default(100),
  MINIO_ENDPOINT: z.string().min(1).refine(
    (value) => !value.includes('://') && !value.includes('/'),
    'must be a hostname or IP address without protocol, port, or path',
  ),
  MINIO_PORT: z.coerce.number().int().min(1).max(65_535).default(9000),
  MINIO_USE_SSL: booleanString.default(true),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET: z.string().min(3),
  MINIO_REGION: z.string().optional(),
  MINIO_PUBLIC_BASE_URL: optionalUrl,
  AVATAR_MAX_BYTES: z.coerce.number().int().min(1).max(50 * 1024 * 1024).default(50 * 1024 * 1024),
  AVATAR_MAX_PIXELS: z.coerce.number().int().min(1).max(100_000_000).default(16_777_216),
  INTEGRATION_SECRET_KEY: z.string().min(32),
  MTEAM_ALLOWED_HOSTS: z.string().default('api.m-team.cc,api.m-team.io').transform((value, context) => {
    const hosts = value.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
    if (hosts.length === 0 || hosts.some((host) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(host))) {
      context.addIssue({ code: 'custom', message: 'must be a comma-separated hostname allowlist' });
      return z.NEVER;
    }
    return [...new Set(hosts)];
  }),
  MTEAM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
  MTEAM_RESOURCE_AVAILABLE_TTL_SECONDS: z.coerce.number().int().min(60).max(604_800).default(86_400),
  MTEAM_RESOURCE_UNAVAILABLE_TTL_SECONDS: z.coerce.number().int().min(60).max(604_800).default(21_600),
  MTEAM_RESOURCE_RETRY_DELAY_SECONDS: z.coerce.number().int().min(10).max(86_400).default(900),
  MTEAM_RESOURCE_CHECK_LEASE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(120),
  MTEAM_SEARCH_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(2_500),
  MTEAM_RELEASE_CACHE_TTL_SECONDS: z.coerce.number().int().min(60).max(300).default(120),
  TRANSMISSION_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
  QBITTORRENT_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
  TELEGRAM_BOT_TOKEN: z.string().trim().regex(/^\d+:[A-Za-z0-9_-]+$/).optional(),
  OPENAI_MODEL: z.string().trim().min(1).max(100).default('gpt-4.1-mini'),
  OPENAI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  OPENAI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  OPENAI_MAX_CONTEXT_TOKENS: z.coerce.number().int().min(1_024).max(1_000_000).default(32_000),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(100_000).default(1_000),
  OPENAI_SUMMARY_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(10_000).default(500),
  OPENAI_HISTORY_LIMIT: z.coerce.number().int().min(1).max(1_000).default(100),
  OPENAI_SYSTEM_PROMPT: z.string().min(1).max(10_000).default('You are a concise movie discovery assistant. Do not invent movie identifiers or availability.'),
  ...trendingFields,
}).superRefine((value, context) => {
  if (value.OPENAI_MAX_OUTPUT_TOKENS >= value.OPENAI_MAX_CONTEXT_TOKENS) {
    context.addIssue({
      code: 'custom',
      path: ['OPENAI_MAX_OUTPUT_TOKENS'],
      message: 'must be smaller than OPENAI_MAX_CONTEXT_TOKENS',
    });
  }
  if (value.OPENAI_SUMMARY_MAX_OUTPUT_TOKENS >= value.OPENAI_MAX_CONTEXT_TOKENS) {
    context.addIssue({
      code: 'custom',
      path: ['OPENAI_SUMMARY_MAX_OUTPUT_TOKENS'],
      message: 'must be smaller than OPENAI_MAX_CONTEXT_TOKENS',
    });
  }
});

const TrendingEnvSchema = z.object({
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ...mongodbFields,
  ...redisFields,
  ...trendingFields,
});

const MigrationEnvSchema = z.object(mongodbFields);

export type AppConfig = z.infer<typeof EnvSchema> & { trustProxy: false | string[] };
export type TrendingConfig = z.infer<typeof TrendingEnvSchema>;
export type MigrationConfig = z.infer<typeof MigrationEnvSchema>;

export class InvalidEnvironmentError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'InvalidEnvironmentError';
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(environment);
  if (!parsed.success) {
    throw new InvalidEnvironmentError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`),
    );
  }

  const trustProxy = parseTrustProxy(parsed.data.TRUST_PROXY);
  return { ...parsed.data, trustProxy };
}

export function loadTrendingConfig(environment: NodeJS.ProcessEnv = process.env): TrendingConfig {
  const parsed = TrendingEnvSchema.safeParse(environment);
  if (!parsed.success) {
    throw new InvalidEnvironmentError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`),
    );
  }
  return parsed.data;
}

export function loadMigrationConfig(environment: NodeJS.ProcessEnv = process.env): MigrationConfig {
  const parsed = MigrationEnvSchema.safeParse(environment);
  if (!parsed.success) {
    throw new InvalidEnvironmentError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`),
    );
  }
  return parsed.data;
}

function parseTrustProxy(value: string): false | string[] {
  if (value === 'true') throw new InvalidEnvironmentError(['TRUST_PROXY: true trusts every proxy; provide explicit trusted addresses or CIDR ranges']);
  if (value === 'false') return false;
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new InvalidEnvironmentError(['TRUST_PROXY: must be true, false, or a comma-separated allowlist']);
  return entries;
}

export const notificationTestEnabled = (config: Pick<AppConfig, 'NODE_ENV'>): boolean =>
  ['development', 'test', 'local', 'dev'].includes(config.NODE_ENV);
