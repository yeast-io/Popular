import { inject, provide } from 'vue';
import type { InjectionKey } from 'vue';
import type { AgentContext } from './agent-context.types';

const contextKey: InjectionKey<AgentContext> = Symbol('agent-context');
export function provideAgentContext(context: AgentContext) {
  provide(contextKey, context);
}
export function useAgentContext(): AgentContext {
  const context = inject(contextKey);
  if (!context) throw new Error('Agent context is required');
  return context;
}
