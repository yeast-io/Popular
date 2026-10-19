import OpenAI from 'openai';
import { OpenAIProbeError } from '../../modules/integrations/openai-settings.service.js';

// Metadata lookup only: never invoke generation or send prompts/history.
export async function probeOpenAI(client: Pick<OpenAI, 'models'>): Promise<string[]> {
  try {
    const response = await client.models.list();
    if (
      response.object !== 'list' ||
      !Array.isArray(response.data) ||
      response.data.some((model) => {
        return model.object !== 'model' || typeof model.id !== 'string' || !model.id.trim() || model.id.length > 256;
      })
    )
      throw new OpenAIProbeError('invalid_response');
    return [...new Set(response.data.map((model) => model.id))].sort();
  } catch (error) {
    if (error instanceof OpenAIProbeError) throw error;
    const upstream = error as { status?: number; code?: string; name?: string } | null;
    if (upstream?.status === 401 || upstream?.status === 403) throw new OpenAIProbeError('authentication');
    if (upstream?.status === 429)
      throw new OpenAIProbeError(upstream.code === 'insufficient_quota' ? 'quota' : 'rate_limit');
    if (upstream?.status === 404 || upstream?.code === 'model_not_found') throw new OpenAIProbeError('model');
    if (error instanceof OpenAI.APIConnectionTimeoutError) throw new OpenAIProbeError('timeout');
    if (error instanceof OpenAI.APIConnectionError) throw new OpenAIProbeError('network');
    // Do not attach raw provider errors: SDK error objects can include sensitive request details.
    throw new OpenAIProbeError('request_failed');
  }
}
