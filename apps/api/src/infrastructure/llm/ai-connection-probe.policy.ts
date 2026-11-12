import type { AiProbeError } from '../../modules/integrations/ai-settings.service.js';

export const AI_PROBE_HTTP_REASONS: ReadonlyMap<number, ConstructorParameters<typeof AiProbeError>[0]> = new Map([
  [401, 'authentication'],
  [403, 'authentication'],
  [402, 'quota'],
  [429, 'rate_limit'],
]);
