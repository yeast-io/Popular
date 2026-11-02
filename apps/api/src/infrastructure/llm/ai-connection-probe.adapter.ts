import type { ProviderHttpOptions } from './provider-http.types.js';
import { ProviderHttpClient } from './provider-http.client.js';
import { AiProbeError } from '../../modules/integrations/ai-settings.service.js';

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
    const reason = value.status === 401 || value.status === 403
      ? 'authentication'
      : value.status === 402
        ? 'quota'
        : value.status === 429
          ? 'rate_limit'
          : value.name === 'TimeoutError' ? 'timeout' : value.status ? 'request_failed' : 'network';
    throw new AiProbeError(reason, { cause: error });
  }
}
