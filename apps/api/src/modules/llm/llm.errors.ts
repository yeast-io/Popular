import type { LlmFailureDiagnostics } from './llm.types.js';

export class LlmProviderError extends Error {
  constructor(message: string, options?: ErrorOptions, public readonly diagnostics?: LlmFailureDiagnostics) {
    super(message, options);
    this.name = 'LlmProviderError';
  }
}
