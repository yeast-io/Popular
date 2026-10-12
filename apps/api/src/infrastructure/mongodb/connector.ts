import mongoose, { type Connection } from 'mongoose';
import type { HealthDependency } from '../health/dependency.js';
import { timedHealthCheck } from '../health/types.js';

export class MongoDbConnector implements HealthDependency {
  readonly name = 'mongodb' as const;
  private connection: Connection | undefined;

  constructor(private readonly uri: string, private readonly databaseName: string) {}

  async connect(): Promise<Connection> {
    if (this.connection?.readyState === 1) return this.connection;
    const connection = mongoose.createConnection(this.uri, {
      dbName: this.databaseName,
      serverSelectionTimeoutMS: 5_000,
      maxPoolSize: 20,
    });
    this.connection = await connection.asPromise();
    return this.connection;
  }

  getConnection(): Connection {
    if (!this.connection || this.connection.readyState !== 1) throw new Error('MongoDB is not connected');
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
