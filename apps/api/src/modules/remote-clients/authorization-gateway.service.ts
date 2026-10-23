import { Value } from '@sinclair/typebox/value';
import { GatewayDeviceStatusSchema } from '@movie-hub/contract';
import type { RemoteAuthorizationChange, DeviceStatus } from '@movie-hub/contract';
import type { RpcCaller } from '@movie-hub/contract/socket-rpc';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import type { AuthorizationGateway, RemoteDeviceRecord } from './remote-client.types.js';

export class AuthorizationGatewayClient implements AuthorizationGateway {
  constructor(private readonly gateway: RpcCaller) {}

  async status(device: RemoteDeviceRecord, correlationId?: string) {
    const response = await this.gateway.call<DeviceStatus>('__get_device_status__', {
      ownerId: device.ownerId, deviceId: device.deviceId, authVersion: device.authVersion, deviceVersion: device.deviceVersion,
    }, correlationId);
    if (!Value.Check(GatewayDeviceStatusSchema, response))
      throw new RpcError('INVALID_GATEWAY_STATUS');
    return response;
  }

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
