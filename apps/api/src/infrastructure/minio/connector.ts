import { Client } from 'minio';
import type { HealthDependency } from '../health/dependency.js';
import { timedHealthCheck } from '../health/types.js';

interface MinioOptions {
  endpoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
}

export class MinioConnector implements HealthDependency {
  readonly name = 'minio' as const;
  private readonly client: Client;

  constructor(
    private readonly options: MinioOptions
  ) {
    this.client = new Client({
      endPoint: options.endpoint,
      port: options.port,
      useSSL: options.useSSL,
      accessKey: options.accessKey,
      secretKey: options.secretKey,
      ...(options.region ? { region: options.region } : {}),
    });
  }

  async connect(): Promise<Client> {
    const exists = await this.client.bucketExists(this.options.bucket);
    if (!exists) throw new Error(`Required MinIO bucket does not exist: ${this.options.bucket}`);
    return this.client;
  }

  getClient(): Client {
    return this.client;
  }

  check() {
    return timedHealthCheck(async () => {
      const exists = await this.client.bucketExists(this.options.bucket);
      if (!exists) throw new Error('MinIO bucket is unavailable');
    });
  }

  async close(): Promise<void> {
    // The MinIO SDK owns no persistent connection that requires explicit shutdown.
  }
}
