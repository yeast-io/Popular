import { createHash } from 'node:crypto';

/** Canonical public-key identity. Use the same function in Gateway binding deduplication. */
export function remoteDeviceKeyFingerprint(keys: unknown): string {
  return createHash('sha256').update(canonical(keys)).digest('hex');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{'
      + Object.entries(value)
        .filter(([, item]) => {
          return item !== undefined;
        })
        .sort(([a], [b]) => {
          return a < b ? -1 : a > b ? 1 : 0;
        })
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',')
        + '}'
    );
  }
  return JSON.stringify(value) ?? 'null';
}
