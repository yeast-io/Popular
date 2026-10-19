export interface DependencyHealth {
  status: 'up' | 'down';
  latencyMs: number;
}
