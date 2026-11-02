import type OpenAI from 'openai';
import type { LlmAccountingOptions } from '../llm/llm-request-accounting.types.js';
import { ResponsesLlmAdapter } from '../llm/responses-llm.adapter.js';

/** DeepSeek's official Responses protocol shares the validated Responses event parser. */
export class DeepSeekLlmAdapter extends ResponsesLlmAdapter {
  constructor(client: Pick<OpenAI, 'responses'>, model: string, accounting: LlmAccountingOptions) {
    super(client, model, { ...accounting, provider: 'deepseek' });
  }
}
