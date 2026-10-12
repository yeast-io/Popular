import type { DependencyHealth } from './types.js';

export interface HealthDependency {
  readonly name: 'mongodb' | 'redis' | 'minio';
  check(): Promise<DependencyHealth>;
  close(): Promise<void>;
}
