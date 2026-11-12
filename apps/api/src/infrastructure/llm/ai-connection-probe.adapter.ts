import type { ProviderHttpOptions } from './provider-http.types.js';
import { ProviderHttpClient } from './provider-http.client.js';
import { AiProbeError } from '../../modules/integrations/ai-settings.service.js';
import { AI_PROBE_HTTP_REASONS } from './ai-connection-probe.policy.js';

export async function probeAiModels(options: ProviderHttpOptions): Promise<string[]> {
  const client = new ProviderHttpClient(options);
  const models: string[] = [];
  let after: string | undefined;
  const cursors = new Set<string>();
  try {
    do {
      const response = await client.request(`/models${after ? `?after_id=${encodeURIComponent(after)}` : ''}`);
      const page = await response.json() as { data?: Array<{ id?: unknown }>; has_more?: boolean; last_id?: string };
      if (!Array.isArray(page.data) || page.data.some((model) => typeof model.id !== 'string' || !model.id || model.id.length > 256))
        throw new AiProbeError('invalid_response');
      models.push(...page.data.map((model) => model.id as string));
      after = options.provider === 'claude' && page.has_more ? page.last_id : undefined;
      if (options.provider === 'claude' && page.has_more && (!after || cursors.has(after)))
        throw new AiProbeError('invalid_response');
      if (after) cursors.add(after);
    } while (after);
    return [...new Set(models)].sort();
  } catch (error) {
    if (error instanceof AiProbeError) throw error;
    const value = error as { status?: number; name?: string };
    const mappedReason = AI_PROBE_HTTP_REASONS.get(value.status ?? 0);
    if (mappedReason) throw new AiProbeError(mappedReason, { cause: error });
    if (value.name === 'TimeoutError') throw new AiProbeError('timeout', { cause: error });
    throw new AiProbeError(value.status ? 'request_failed' : 'network', { cause: error });
  }
}
