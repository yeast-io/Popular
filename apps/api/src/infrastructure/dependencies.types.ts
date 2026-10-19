import type { HealthDependency } from './health/health-dependency.types.js';
import type { MinioConnector } from './minio/connector.js';
import type { MongoDbConnector } from './mongodb/connector.js';
import type { RedisConnector } from './redis/connector.js';

export interface Infrastructure {
  mongodb: MongoDbConnector;
  redis: RedisConnector;
  minio: MinioConnector;
  healthDependencies: HealthDependency[];
}
