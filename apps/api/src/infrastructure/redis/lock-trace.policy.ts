import type { LockAction } from './lock-trace.types.js';

export const LOCK_OUTCOMES: ReadonlyMap<LockAction, { success: string; failure: string }> = new Map([
  ['acquire', { success: 'acquired', failure: 'busy' }],
  ['renew', { success: 'renewed', failure: 'lost' }],
  ['release', { success: 'released', failure: 'not_owned' }],
  ['checkpoint', { success: 'checkpointed', failure: 'lost' }],
]);
