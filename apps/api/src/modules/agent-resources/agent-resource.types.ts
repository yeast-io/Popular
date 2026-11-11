import type { RpcCaller } from '@movie-hub/contract/socket-rpc';
import type { IntegrationPreferencesStore } from '../integrations/integration-preferences.types.js';
import type { RemoteAuthorizationStore } from '../remote-clients/remote-client.types.js';

export interface AgentResourceDependencies {
  preferences: IntegrationPreferencesStore;
  authorization: Pick<RemoteAuthorizationStore, 'account' | 'device'>;
  gateway: RpcCaller;
}
