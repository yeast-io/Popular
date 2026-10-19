

export interface TrendingSyncResult {
  status: 'completed' | 'skipped';
  pages: number;
  movies: number;
}

export type TrendingSyncTrigger = 'manual' | 'load-more' | 'request' | 'scheduler';

export interface TrendingSyncLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface SyncContext {
  runId: string;
  trigger: TrendingSyncTrigger;
  scope: 'configured-pages' | 'page';
}
