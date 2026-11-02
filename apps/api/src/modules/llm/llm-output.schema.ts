import type { z } from 'zod';
import type { LlmFailureDiagnostics } from './llm.types.js';
import { LlmProviderError } from './llm.errors.js';
import { currentAiTrace } from '../../infrastructure/logging/ai-trace.js';

/** Never retain parser messages: JSON and schema errors can quote private model output. */
function outputFailure(cause: unknown, diagnostics: LlmFailureDiagnostics): never {
  const safeCause = new Error('Structured output validation failed');
  if (cause instanceof Error) {
    safeCause.name = cause.name;
    // Preserve original call frames, excluding multiline messages and quoted payloads.
    const header = `${cause.name}: ${cause.message}`;
    const frames = cause.stack?.startsWith(header) ? cause.stack.slice(header.length) : '';
    safeCause.stack = `${safeCause.name}: ${safeCause.message}${frames}`;
  }
  const error = new LlmProviderError('AI provider returned invalid structured output', { cause: safeCause }, diagnostics);
  currentAiTrace()?.fail(error, { ...diagnostics, stage: 'llm.output.validate', outcome: 'failure' });
  throw error;
}

export function parseLlmJson(content: string, diagnostics: LlmFailureDiagnostics): unknown {
  try {
    return JSON.parse(content);
  } catch (cause) {
    outputFailure(cause, { ...diagnostics, reason: 'invalid_json' });
  }
}

export function parseLlmOutput<T>(schema: z.ZodType<T>, content: string, diagnostics: LlmFailureDiagnostics): T {
  const value = parseLlmJson(content, diagnostics);
  try {
    return schema.parse(value);
  } catch (cause) {
    outputFailure(cause, { ...diagnostics, reason: 'invalid_schema' });
  }
}
