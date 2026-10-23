import { Type, type Static } from '@sinclair/typebox';
import { RpcIdSchema as id } from './socket-rpc.schema.js';
import { RemoteAuthorizationChangeSchema } from '../remote-client.schema.js';

const integer = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const hash = Type.String({ pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' });
const object = { additionalProperties: false } as const;
export const GatewayDeviceKeysSchema = Type.Object({
  signingKey: Type.Object({ kty: Type.Literal('OKP'), crv: Type.Literal('Ed25519'), x: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }) }, object),
  encryptionKey: Type.Object({ kty: Type.Literal('RSA'), n: Type.String({ minLength: 342, maxLength: 683, pattern: '^[A-Za-z0-9_-]+$' }), e: Type.Literal('AQAB') }, object),
}, object);
export const GatewaySessionSchema = Type.Object({ ownerId: id, deviceId: id, authVersion: integer, deviceVersion: integer,
  sessionId: id, instanceId: id }, object);
export const GatewayAgentStatusSchema = Type.Object({ downloaderType: Type.Union([Type.Literal('qbittorrent'), Type.Literal('transmission')]),
  instanceId: id, configured: Type.Boolean(), reachable: Type.Boolean() }, object);
export const GatewayDeviceStatusSchema = Type.Object({
  online: Type.Boolean(), isAgentOnline: Type.Boolean(), isAgentDownloaderOnline: Type.Boolean(),
  checkedAt: Type.Number({ minimum: 0 }), statusObservedAt: Type.Optional(Type.Number({ minimum: 0 })),
  session: Type.Optional(GatewaySessionSchema), agentStatus: Type.Optional(Type.Union([GatewayAgentStatusSchema, Type.Null()])),
}, object);
export const GatewayDownloadSchema = Type.Object({ commandId: id, downloadId: id, ownerId: id, deviceId: id,
  authVersion: integer, deviceVersion: integer, source: Type.Union([Type.Literal('mteam'), Type.Literal('hdarea')]),
  resourceId: id, correlationId: id }, object);
export const GatewayEvidenceSchema = Type.Object({ downloaderType: Type.Union([Type.Literal('qbittorrent'), Type.Literal('transmission')]),
  instanceId: id, torrentHash: hash, taskId: id, marker: Type.String({ minLength: 1, maxLength: 168, pattern: '^[A-Za-z0-9_-]+$' }) }, object);
export const GatewayResultSchema = Type.Object({ commandId: id, executionId: id,
  outcome: Type.Union(['succeeded', 'duplicate', 'failed', 'unknown'].map((value) => {
    return Type.Literal(value);
  })), evidence: Type.Optional(GatewayEvidenceSchema) }, object);
export const GatewayStatusSchema = Type.Object({ commandId: id, executionId: id, sequence: integer, evidence: GatewayEvidenceSchema,
  state: Type.Union(['downloading', 'completed', 'paused', 'failed', 'unreachable', 'deleted'].map((value) => {
    return Type.Literal(value);
  })),
  progress: Type.Number({ minimum: 0, maximum: 1 }), downloadedBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  totalBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), downloadSpeed: Type.Number({ minimum: 0 }), uploadSpeed: Type.Number({ minimum: 0 }) }, object);
export const AgentQueueRequestSchema = Type.Object({
  cursor: Type.Optional(Type.String({ maxLength: 200, pattern: '^[0-9]+:[A-Za-z0-9_-]+$' })),
}, object);
export const AgentQueueItemSchema = Type.Object({
  commandId: id, resourceId: id, source: Type.Union([Type.Literal('mteam'), Type.Literal('hdarea')]),
  title: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
  enqueuedAt: integer, expiresAt: integer,
  reason: Type.Union(['queued', 'agent_offline', 'downloader_unavailable', 'target_changed', 'gateway_unavailable',
    'retrying', 'verifying', 'executing'].map((value) => Type.Literal(value))),
}, object);
export const AgentQueueSnapshotSchema = Type.Object({
  observedAt: integer, total: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  cursor: Type.Optional(AgentQueueRequestSchema.properties.cursor),
  nextCursor: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  items: Type.Array(AgentQueueItemSchema, { maxItems: 50 }),
}, object);
export type AgentQueueItem = Static<typeof AgentQueueItemSchema>;
export type AgentQueueSnapshot = Static<typeof AgentQueueSnapshotSchema>;
const event = { context: GatewaySessionSchema, agentMessageId: id, agentDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }) };
export const PopularRpcSchemas = {
  __list_queued_downloads__: Type.Object({ context: GatewaySessionSchema, ...AgentQueueRequestSchema.properties }, object),
  __resolve_client_authorization__: Type.Object({ keyDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }), deviceId: Type.Optional(id) }, object),
  __bind_device__: Type.Object({ keyDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }), authVersion: integer, operationId: id, keys: GatewayDeviceKeysSchema }, object),
  __validate_session__: Type.Object({ context: GatewaySessionSchema }, object),
  __prepare_delivery__: Type.Object({ context: GatewaySessionSchema, commandId: id }, object),
  __save_delivery__: Type.Object({ context: GatewaySessionSchema, commandId: id, deliveryMessageId: id,
    envelope: Type.String({ minLength: 1, maxLength: 60000 }) }, object),
  __confirm_command_received__: Type.Object({ ...event, commandId: id }, object),
  __authorize_execution__: Type.Object({ context: GatewaySessionSchema, commandId: id, executionId: id, downloader: GatewayAgentStatusSchema }, object),
  __record_command_result__: Type.Object({ ...event, result: GatewayResultSchema }, object),
  __record_download_status__: Type.Object({ ...event, status: GatewayStatusSchema }, object),
  __recover_execution__: Type.Object({ context: GatewaySessionSchema, commandId: id, executionId: id }, object),
  __list_pending_deliveries__: Type.Object({ context: GatewaySessionSchema }, object),
} as const;
export const GatewayRpcSchemas = {
  __get_device_status__: Type.Object({ ownerId: id, deviceId: id, authVersion: integer, deviceVersion: integer }, object),
  __dispatch_download__: GatewayDownloadSchema,
  __authorization_changed__: RemoteAuthorizationChangeSchema,
  __command_closed__: Type.Object({ eventId: id, commandId: id, ownerId: id, deviceId: id,
    authVersion: integer, deviceVersion: integer }, object),
} as const;
export const ServiceHelloSchema = Type.Object({ popularInstanceId: id, poolSlotId: id }, object);
