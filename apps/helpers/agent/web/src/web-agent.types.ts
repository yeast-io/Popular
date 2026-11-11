import type { AgentClient } from '@movie-hub/helper-agent-ui/transport';

export interface ManagementSession {
  authenticated: boolean;
  usernameRequired?: boolean;
  csrf?: string;
  version: string;
}
export interface WebAgentOptions {
  onSessionExpired(): void;
}
export interface WebAgentClient {
  client: AgentClient;
  session(): Promise<ManagementSession>;
  login(password: string, username?: string): Promise<ManagementSession>;
  logout(): Promise<void>;
  close(): void;
}
