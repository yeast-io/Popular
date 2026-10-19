import type { ExternalRequestContext, ExternalRequestTrigger } from './external-usage.types.js';

export const systemExternalRequestContext = (trigger: ExternalRequestTrigger): ExternalRequestContext => {
  return { actorType: 'system', trigger };
};

export const userExternalRequestContext = (
  ownerId: string | null,
  trigger: ExternalRequestTrigger,
): ExternalRequestContext => {
  return ownerId ? { actorType: 'user', ownerId, trigger } : { actorType: 'anonymous', trigger };
};
