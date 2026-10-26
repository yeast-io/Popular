import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from '../../apps/api/node_modules/dotenv/lib/main.js';
import { loadConfig } from '../../apps/api/src/config/env.ts';
import { MongoDbConnector } from '../../apps/api/src/infrastructure/mongodb/connector.ts';
import { RedisConnector } from '../../apps/api/src/infrastructure/redis/connector.ts';
import { MinioConnector } from '../../apps/api/src/infrastructure/minio/connector.ts';
import { MinioAvatarStore } from '../../apps/api/src/infrastructure/minio/avatar.store.ts';
import { createLoggers } from '../../apps/api/src/infrastructure/logging/logger.ts';
import { deleteUserData, parseDeleteUserArguments } from './delete-user.store.mjs';
import { deleteUserMessages } from './delete-user.messages.mjs';

loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });
const copy = deleteUserMessages[process.env.USER_DELETE_LOCALE === 'en-US' ? 'en-US' : 'zh-CN'];
if (process.argv.slice(2).includes('--help')) {
  console.log(copy.usage);
} else {
  const correlationId = randomUUID();
  const startedAt = Date.now();
  let stage = 'configuration';
  let mongodb;
  let redis;
  let loggers;
  try {
    let input;
    try {
      input = parseDeleteUserArguments(process.argv.slice(2));
    } catch (cause) {
      throw new Error(copy.invalidArguments, { cause });
    }
    const config = loadConfig();
    loggers = createLoggers(config.LOG_LEVEL);
    const report = (nextStage, fields) => {
      stage = nextStage;
      if (config.VERBOSE) loggers.app.info({ correlationId, stage, outcome: 'completed', durationMs: Date.now() - startedAt, ...fields });
    };
    stage = 'mongodb.connect';
    mongodb = new MongoDbConnector(config.MONGODB_URI, config.MONGODB_DB_NAME);
    const connection = await mongodb.connect();
    stage = 'redis.connect';
    // Use raw keys here because SCAN returns fully prefixed keys.
    redis = new RedisConnector(config.REDIS_URL, '');
    const client = await redis.connect();
    const minio = new MinioConnector({ endpoint: config.MINIO_ENDPOINT, port: config.MINIO_PORT, useSSL: config.MINIO_USE_SSL,
      accessKey: config.MINIO_ACCESS_KEY, secretKey: config.MINIO_SECRET_KEY, bucket: config.MINIO_BUCKET,
      ...(config.MINIO_REGION ? { region: config.MINIO_REGION } : {}),
    });
    stage = 'user.cleanup';
    const result = await deleteUserData({ database: connection.db, redis: client,
      avatars: new MinioAvatarStore(minio.getClient(), config.MINIO_BUCKET),
      prefix: config.REDIS_KEY_PREFIX, pepper: config.SESSION_TOKEN_PEPPER,
      ...input, report,
    });
    console.log(JSON.stringify({ correlationId, outcome: input.dryRun ? 'dry_run' : 'completed', ...result,
      message: input.dryRun ? copy.preview : copy.completed }));
  } catch (error) {
    if (error.message === 'INVALID_AVATAR') error.message = copy.invalidAvatar;
    const logger = loggers ?? createLoggers('error');
    logger.error.error({ correlationId, stage, outcome: 'failed', durationMs: Date.now() - startedAt, err: error }, copy.failed);
    process.exitCode = 1;
  } finally {
    await redis?.close();
    await mongodb?.close();
  }
}
