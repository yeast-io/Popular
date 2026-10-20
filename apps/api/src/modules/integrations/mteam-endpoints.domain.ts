import type { IntegrationConfigStore, MTeamEndpoints } from './integration.types.js';

/** Runtime endpoints override historical addresses without rewriting encrypted owner credentials. */
export function withMTeamEndpoints(store: IntegrationConfigStore, endpoints: MTeamEndpoints): IntegrationConfigStore {
  return {
    async find(ownerId, provider) {
      const record = await store.find(ownerId, provider);
      return record ? { ...record, ...endpoints } : null;
    },
    async saveVerified(input) { return { ...await store.saveVerified({ ...input, ...endpoints }), ...endpoints }; },
    recordFailure: (ownerId, provider, attemptedAt, failureType) => {
      return store.recordFailure(ownerId, provider, attemptedAt, failureType);
    },
    delete: (ownerId, provider) => store.delete(ownerId, provider),
  };
}
