import type { AppConfig } from '../config/env.js';
import type { HealthDependency } from './health/dependency.js';
import { MinioConnector } from './minio/connector.js';
import { MongoDbConnector } from './mongodb/connector.js';
import { RedisConnector } from './redis/connector.js';

export interface Infrastructure {
  mongodb: MongoDbConnector;
  redis: RedisConnector;
  minio: MinioConnector;
  healthDependencies: HealthDependency[];
}

export function createInfrastructure(config: AppConfig): Infrastructure {
  const mongodb = new MongoDbConnector(config.MONGODB_URI, config.MONGODB_DB_NAME);
  const redis = new RedisConnector(config.REDIS_URL, config.REDIS_KEY_PREFIX);
  const minio = new MinioConnector({
    endpoint: config.MINIO_ENDPOINT,
    port: config.MINIO_PORT,
    useSSL: config.MINIO_USE_SSL,
    accessKey: config.MINIO_ACCESS_KEY,
    secretKey: config.MINIO_SECRET_KEY,
    bucket: config.MINIO_BUCKET,
    ...(config.MINIO_REGION ? { region: config.MINIO_REGION } : {}),
  });
  return { mongodb, redis, minio, healthDependencies: [mongodb, redis, minio] };
}

export async function connectInfrastructure(infrastructure: Infrastructure): Promise<void> {
  try {
    const results = await Promise.allSettled([
      infrastructure.mongodb.connect(),
      infrastructure.redis.connect(),
      infrastructure.minio.connect(),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  } catch (error) {
    await closeInfrastructure(infrastructure);
    throw error;
  }
}

export async function closeInfrastructure(infrastructure: Infrastructure): Promise<void> {
  await Promise.allSettled(
    infrastructure.healthDependencies.map((dependency) => {
      return dependency.close();
    }),
  );
}
