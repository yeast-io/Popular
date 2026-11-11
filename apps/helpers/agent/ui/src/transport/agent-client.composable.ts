import { inject, provide } from 'vue';
import type { InjectionKey } from 'vue';
import type { AgentClient } from './agent-transport.types';

const clientKey: InjectionKey<AgentClient> = Symbol('agent-client');
export function provideAgentClient(client: AgentClient) {
  provide(clientKey, client);
}
export function useAgentClient(): AgentClient {
  const client = inject(clientKey);
  if (!client) throw new Error('Agent client is required');
  return client;
}
