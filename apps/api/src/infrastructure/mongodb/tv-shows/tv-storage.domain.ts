// Successful full responses clear removed upstream fields; summary writes remain patches.
export function tvFieldUpdate(fields: Record<string, unknown>) {
  const $set = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  const $unset = Object.fromEntries(Object.entries(fields).filter(([, value]) => value === undefined).map(([key]) => [key, 1 as const]));
  return { $set, ...(Object.keys($unset).length ? { $unset } : {}) };
}
