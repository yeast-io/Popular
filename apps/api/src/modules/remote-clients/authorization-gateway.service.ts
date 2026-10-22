import type { RemoteAuthorizationChange } from '@movie-hub/contract';
import type { RpcCaller } from '@movie-hub/contract/socket-rpc';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import type { AuthorizationGateway } from './remote-client.types.js';

export class AuthorizationGatewayClient implements AuthorizationGateway {
  constructor(private readonly gateway: RpcCaller) {}

  async notify(event: RemoteAuthorizationChange): Promise<void> {
    const response = await this.gateway.call<{ applied: boolean; eventId: string }>(
      '__authorization_changed__',
      event,
      event.correlationId,
      event.eventId
    );
    if (response.applied !== true || response.eventId !== event.eventId) throw new RpcError('INVALID_GATEWAY_ACK');
  }
}
