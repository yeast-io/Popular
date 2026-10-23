import { createHash } from 'node:crypto';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import type { CommandRecord, PublicCommand, Session, AgentQueueItem } from '@movie-hub/contract';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{'
      + Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => {
          return a < b ? -1 : a > b ? 1 : 0;
        })
        .map(([k, v]) => {
          return JSON.stringify(k) + ':' + canonical(v);
        })
        .join(',')
        + '}'
    );
  return JSON.stringify(value) ?? 'null';
}
export const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function ensure(value: unknown, code: string): asserts value {
  if (!value) throw new RpcError(code, 'not_applied');
}
export const awaitingExecution = (c: CommandRecord) => ['accepted', 'delivered', 'received'].includes(c.state);
export function checkContext(c: CommandRecord, s: Session) {
  ensure(
    c.ownerId === s.ownerId
    && c.deviceId === s.deviceId
    && c.authVersion === s.authVersion
    && c.deviceVersion === s.deviceVersion,
    'COMMAND_AUTHORIZATION_MISMATCH'
  );
}
export function publicCommand(c: CommandRecord): PublicCommand {
  return {
    commandId: c.commandId,
    downloadId: c.downloadId,
    state: c.state,
    expiresAt: c.expiresAt,
    executionId: c.executionId,
    grantExpiresAt: c.grantExpiresAt,
    result: c.result,
    accepted: true,
    added:
      c.result?.outcome === 'succeeded'
        ? true
        : c.result?.outcome === 'duplicate' || c.result?.outcome === 'failed'
          ? false
          : c.executionId
            ? null
            : false,
  };
}

export function queueReason(command: Pick<CommandRecord, 'state' | 'lastErrorCode'>): AgentQueueItem['reason'] {
  if (command.lastErrorCode === 'RESOURCE_TORRENT_DAILY_LIMIT') return 'torrent_daily_limit';
  if (command.state === 'unknown') return 'verifying';
  if (command.state === 'granted') return 'executing';
  if (command.lastErrorCode === 'DEVICE_OFFLINE') return 'agent_offline';
  if (command.lastErrorCode === 'DOWNLOADER_UNAVAILABLE') return 'downloader_unavailable';
  if (command.lastErrorCode === 'DOWNLOADER_INSTANCE_MISMATCH') return 'target_changed';
  if (command.lastErrorCode === 'GATEWAY_UNAVAILABLE') return 'gateway_unavailable';
  return command.state === 'failed' ? 'retrying' : 'queued';
}
