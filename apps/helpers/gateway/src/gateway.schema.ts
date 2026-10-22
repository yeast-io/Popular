import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_-]+$/);
const hash = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const keysSchema = z
  .object({
    signingKey: z
      .object({
        kty: z.literal('OKP'),
        crv: z.literal('Ed25519'),
        x: z
          .string()
          .length(43)
          .regex(/^[A-Za-z0-9_-]+$/),
      })
      .strict(),
    encryptionKey: z
      .object({
        kty: z.literal('RSA'),
        n: z
          .string()
          .min(342)
          .max(683)
          .regex(/^[A-Za-z0-9_-]+$/),
        e: z.literal('AQAB'),
      })
      .strict(),
  })
  .strict();
export const wireSchema = z
  .object({
    protocolVersion: z.literal(1),
    command: z.string().regex(/^__[a-z_]+__$/),
    messageId: id,
    replyTo: id.optional(),
    correlationId: id.optional(),
    payload: z.unknown(),
  })
  .strict();
export const authenticateSchema = z
  .object({
    keys: keysSchema,
    intent: z.enum(['bind', 'authenticate']),
    deviceId: id.optional(),
    operationId: id.optional(),
  })
  .strict();
export const proofSchema = z.object({ proof: z.string().min(1).max(8192) }).strict();
export const identitySchema = z.object({ commandId: id }).strict();
export const executionSchema = z.object({ commandId: id, executionId: id }).strict();
export const evidenceSchema = z
  .object({
    downloaderType: z.enum(['qbittorrent', 'transmission']),
    instanceId: id,
    torrentHash: hash,
    taskId: id,
    marker: z
      .string()
      .min(1)
      .max(168)
      .regex(/^[a-zA-Z0-9_-]+$/),
  })
  .strict();
export const resultSchema = executionSchema
  .extend({ outcome: z.enum(['succeeded', 'duplicate', 'failed', 'unknown']), evidence: evidenceSchema.optional() })
  .strict();
export const statusSchema = executionSchema
  .extend({
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    evidence: evidenceSchema,
    state: z.enum(['downloading', 'completed', 'paused', 'failed', 'unreachable', 'deleted']),
    progress: z.number().min(0).max(1),
    downloadedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    downloadSpeed: z.number().nonnegative(),
    uploadSpeed: z.number().nonnegative(),
  })
  .strict();
export const agentStatusSchema = z
  .object({
    downloaderType: z.enum(['qbittorrent', 'transmission']),
    instanceId: id,
    configured: z.boolean(),
    reachable: z.boolean(),
  })
  .strict();
export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  ALLOW_INSECURE_DEV: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  VERBOSE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4310),
  REDIS_URL: z.url(),
  INTERNAL_INBOUND_TOKEN: z.string().min(32),
  SIGNING_PRIVATE_KEY_FILE: z.string().min(1),
  SIGNING_KEY_ID: id,
  TLS_TERMINATION: z.enum(['proxy', 'direct']).default('direct'),
  TLS_CERT_FILE: z.string().optional(),
  TLS_KEY_FILE: z.string().optional(),
});

export const protocolErrorSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Z0-9_]+$/),
  })
  .strict();
