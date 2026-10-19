import type { DependencyHealth } from './health.types.js';

export interface HealthDependency {
  readonly name: 'mongodb' | 'redis' | 'minio';
  check(): Promise<DependencyHealth>;
  close(): Promise<void>;
}
