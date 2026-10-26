import { RESOURCE_NOTIFICATION_INTERVAL_MS } from '../modules/resource-notifications/resource-notification.policy.js';
import { z } from 'zod';
import { mediaTrendingPolicy } from '../modules/media-trending/media-trending.policy.js';
import { DEFAULT_OPENAI_SYSTEM_PROMPT } from './system-prompts/default.prompts.js';
import { supportedLocales } from '@movie-hub/contract';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const optionalUrl = z
  .string()
  .url()
  .optional()
  .or(z.literal('').transform(() => undefined));

const resourceSiteOrigin = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && (!url.port || url.port === '443')
      && url.pathname === '/'
    );
  }, 'must be an HTTPS origin without credentials, path, query or fragment')
  .transform((value) => new URL(value).origin);

const mongodbFields = {
  MONGODB_URI: z.url().refine((url) => {
    return ['mongodb:', 'mongodb+srv:'].includes(new URL(url).protocol);
  }, 'must use mongodb:// or mongodb+srv://'),
  MONGODB_DB_NAME: z
    .string()
    .regex(/^[^/\\. "*$<>:|?]+$/, 'contains characters MongoDB does not allow')
    .default('movie_hub'),
};

const redisFields = {
  REDIS_URL: z.url().refine((url) => {
    return ['redis:', 'rediss:'].includes(new URL(url).protocol);
  }, 'must use redis:// or rediss://'),
  REDIS_KEY_PREFIX: z.string().min(1).default('movie_hub:'),
  REDIS_LOCK_TRACE_ENABLED: booleanString.default(false),
};

const trendingFields = {
  TMDB_READ_ACCESS_TOKEN: z.string().min(1),
  TMDB_LANGUAGE: z.enum(supportedLocales).default('zh-CN'),
  TMDB_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
  MEDIA_TRENDING_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(86_400).default(mediaTrendingPolicy.defaultTtlSeconds),
};

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'local', 'dev', 'production']).default('development'),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    WEB_ORIGIN: z.string().url(),
    TRUST_PROXY: z.string().default('false'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    ACCESS_LOG_ENABLED: booleanString.default(true),
    VERBOSE: booleanString.default(false),
    RESOURCE_NOTIFICATION_INTERVAL_MS: z.coerce.number().int().min(60_000).max(2_147_483_647).default(RESOURCE_NOTIFICATION_INTERVAL_MS),
    PAGE_AI_ASSISTANT_ENABLED: booleanString.default(true),
    ...mongodbFields,
    ...redisFields,
    SESSION_COOKIE_NAME: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .default('movie_hub_session'),
    SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(31_536_000).default(2_592_000),
    SESSION_TOKEN_PEPPER: z.string().min(32),
    SESSION_COOKIE_SECURE: booleanString.default(false),
    MAILGUN_API_KEY: z.string().trim().min(1).optional().or(z.literal('').transform(() => undefined)),
    MAILGUN_BASE_URL: z.url().default('https://api.mailgun.net').refine((value) => {
      const url = new URL(value);
      return url.protocol === 'https:' && ['api.mailgun.net', 'api.eu.mailgun.net'].includes(url.hostname)
        && !url.username && !url.password && !url.port && !url.search && !url.hash
        && ['/', '/v3', '/v3/'].includes(url.pathname);
    }, 'must be an official Mailgun HTTPS API base URL'),
    MAILGUN_DOMAIN: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/).default('mail.gofloat.cn'),
    MAILGUN_FROM: z.string().min(1).refine((value) => !/[\r\n]/.test(value)).default('Popular <noreply@mail.gofloat.cn>'),
    REGISTRATION_USER_LIMIT: z.coerce.number().int().min(1).default(100),
    MINIO_ENDPOINT: z
      .string()
      .min(1)
      .refine(
        (value) => !value.includes('://') && !value.includes('/'),
        'must be a hostname or IP address without protocol, port, or path'
      ),
    MINIO_PORT: z.coerce.number().int().min(1).max(65_535).default(9000),
    MINIO_USE_SSL: booleanString.default(true),
    MINIO_ACCESS_KEY: z.string().min(1),
    MINIO_SECRET_KEY: z.string().min(1),
    MINIO_BUCKET: z.string().min(3),
    MINIO_REGION: z.string().optional(),
    MINIO_PUBLIC_BASE_URL: optionalUrl,
    AVATAR_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(50 * 1024 * 1024)
      .default(50 * 1024 * 1024),
    AVATAR_MAX_PIXELS: z.coerce.number().int().min(1).max(100_000_000).default(16_777_216),
    REMOTE_GATEWAY_BASE_URL: optionalUrl,
    REMOTE_GATEWAY_POOL_SIZE: z.coerce.number().int().min(1).max(32).default(4),
    REMOTE_GATEWAY_SERVICE_TOKEN: z
      .string()
      .min(32)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    INTEGRATION_SECRET_KEY: z.string().min(32),
    HDAREA_BASE_URL: resourceSiteOrigin.default('https://hdarea.club'),
    MTEAM_BASE_URL: resourceSiteOrigin.default('https://api.m-team.cc'),
    MTEAM_WEB_BASE_URL: resourceSiteOrigin.default('https://kp.m-team.cc'),
    MTEAM_ALLOWED_HOSTS: z
      .string()
      .default('api.m-team.cc,api.m-team.io')
      .transform((value, context) => {
        const hosts = value
          .split(',')
          .map((host) => host.trim().toLowerCase())
          .filter(Boolean);
        if (
          hosts.length === 0
          || hosts.some((host) => {
            return !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(
              host
            );
          })
        ) {
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
    RESOURCE_RELEASE_CACHE_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(1_800),
    TRANSMISSION_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
    QBITTORRENT_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
    SCAN_TRACE_ENABLED: booleanString.default(false),
    TELEGRAM_POLL_TRACE_ENABLED: booleanString.default(false),
    TELEGRAM_BOT_TOKEN: z
      .string()
      .trim()
      .regex(/^\d+:[A-Za-z0-9_-]+$/)
      .optional(),
    ASSISTANT_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    ASSISTANT_SCAN_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),
    OPENAI_RECOMMENDED_MODELS: z
      .string()
      .max(16_384)
      .default('')
      .transform((value) => {
        return [
          ...new Set(
            value
              .split(',')
              .map((model) => model.trim())
              .filter(Boolean)
          ),
        ];
      })
      .pipe(z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/)).max(100)),
    OPENAI_MODEL: z.string().trim().min(1).max(100).default('gpt-5.6-sol'),
    OPENAI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
    OPENAI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    OPENAI_MAX_CONTEXT_TOKENS: z.coerce.number().int().min(1_024).max(1_000_000).default(32_000),
    OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(100_000).default(1_000),
    OPENAI_SUMMARY_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(10_000).default(500),
    OPENAI_HISTORY_LIMIT: z.coerce.number().int().min(1).max(1_000).default(100),
    OPENAI_SYSTEM_PROMPT: z.string().min(1).max(10_000).default(DEFAULT_OPENAI_SYSTEM_PROMPT),
    ...trendingFields,
  })
  .superRefine((value, context) => {
    if (Boolean(value.REMOTE_GATEWAY_BASE_URL) !== Boolean(value.REMOTE_GATEWAY_SERVICE_TOKEN)) {
      context.addIssue({
        code: 'custom',
        path: ['REMOTE_GATEWAY_BASE_URL'],
        message: 'Gateway URL and service token must be configured together',
      }
      );
    }
    if (value.REMOTE_GATEWAY_BASE_URL) {
      const url = new URL(value.REMOTE_GATEWAY_BASE_URL);
      if (
        !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
        || url.username
        || url.password
        || url.search
        || url.hash
        || url.pathname !== '/'
      ) {
        context.addIssue({
          code: 'custom',
          path: ['REMOTE_GATEWAY_BASE_URL'],
          message: 'Gateway URL must be an HTTP(S)/WS(S) origin without credentials, path, query or fragment',
        }
        );
      }
    }
    if (value.OPENAI_MAX_OUTPUT_TOKENS >= value.OPENAI_MAX_CONTEXT_TOKENS) {
      context.addIssue({
        code: 'custom',
        path: ['OPENAI_MAX_OUTPUT_TOKENS'],
        message: 'must be smaller than OPENAI_MAX_CONTEXT_TOKENS',
      }
      );
    }
    if (value.OPENAI_SUMMARY_MAX_OUTPUT_TOKENS >= value.OPENAI_MAX_CONTEXT_TOKENS) {
      context.addIssue({
        code: 'custom',
        path: ['OPENAI_SUMMARY_MAX_OUTPUT_TOKENS'],
        message: 'must be smaller than OPENAI_MAX_CONTEXT_TOKENS',
      }
      );
    }
  });

export const MongoMaintenanceEnvSchema = z.object({ ...mongodbFields });

export type AppConfig = z.infer<typeof EnvSchema> & { trustProxy: false | string[] };

export type MongoMaintenanceConfig = z.infer<typeof MongoMaintenanceEnvSchema>;
