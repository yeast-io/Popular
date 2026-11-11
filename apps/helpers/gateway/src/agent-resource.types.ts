import type { AgentResourceRequest, Session } from '@movie-hub/contract';

export interface ResourcePending {
  session: Session;
  correlationId: string;
  operation: AgentResourceRequest['operation'];
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
