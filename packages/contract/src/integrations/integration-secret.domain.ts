import { INTEGRATION_SECRET_MASK_CHARACTER } from './integration-secret.policy.js';

/** Length is counted in Unicode code points; short credentials never expose overlapping ends. */
export function maskIntegrationSecret(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= 12) return INTEGRATION_SECRET_MASK_CHARACTER.repeat(characters.length);
  return characters.slice(0, 6).join('') + INTEGRATION_SECRET_MASK_CHARACTER.repeat(characters.length - 12) + characters.slice(-6).join('');
}
