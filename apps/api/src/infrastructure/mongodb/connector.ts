import mongoose, { type Connection } from 'mongoose';
import type { HealthDependency } from '../health/health-dependency.types.js';
import { timedHealthCheck } from '../health/health-check.service.js';
import { createPrettyLoggers } from '../logging/logger.js';

const logger = createPrettyLoggers();

export class MongoDbConnector implements HealthDependency {
  readonly name = 'mongodb' as const;
  private connection: Connection | undefined;

  constructor(private readonly uri: string, private readonly databaseName: string) {}

  async connect(): Promise<Connection> {
    if (this.connection?.readyState === 1) return this.connection;
    const connection = mongoose.createConnection(this.uri, {
      dbName: this.databaseName,
      serverSelectionTimeoutMS: 10_000,
      maxPoolSize: 20,
    });
    connection.on('connected', () => logger.info('mongodb connected'));
    connection.on('disconnected', () => logger.info('disconnected from mongodb'));
    connection.on('reconnected', () => logger.info('reconnected to mongodb'));
    connection.on('disconnecting', () => logger.info('mongodb connection is disconnecting'));
    connection.on('close', () => logger.info('connection is closed'));
    this.connection = await connection.asPromise();
    return this.connection;
  }

  getConnection(): Connection {
    if (!this.connection || this.connection.readyState !== 1) {
      throw new Error('MongoDB is not connected');
    }
    return this.connection;
  }

  check() {
    return timedHealthCheck(async () => {
      const database = this.getConnection().db;
      if (!database) throw new Error('MongoDB database handle is unavailable');
      await database.admin().ping();
    });
  }

  async close(): Promise<void> {
    if (this.connection) await this.connection.close();
    this.connection = undefined;
  }
}
