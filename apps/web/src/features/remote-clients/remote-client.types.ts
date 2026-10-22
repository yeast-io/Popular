import type { RemoteClientDevice } from '@movie-hub/contract';

export type RemoteClientAction = 'generate' | 'regenerate' | 'revoke';
export type RemoteClientConfirmation = { kind: 'regenerate' | 'revoke' } | { kind: 'unbind'; device: RemoteClientDevice };
