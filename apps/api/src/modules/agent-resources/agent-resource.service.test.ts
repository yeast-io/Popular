import assert from 'node:assert/strict';
import test from 'node:test';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import { AgentResourceService } from './agent-resource.service.js';
import { AgentResourceSource } from './agent-resource-source.adapter.js';
import { RemoteTorrentService } from '../remote-downloads/remote-torrent.service.js';
import { ResourceSiteError } from '../resource-sites/resource-site.errors.js';
import { AiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type {
  IntegrationPreferencesRecord,
  IntegrationPreferencesStore,
} from '../integrations/integration-preferences.types.js';
import type { RemoteClientAccount, RemoteDeviceRecord } from '../remote-clients/remote-client.types.js';

function fixture() {
  let row: IntegrationPreferencesRecord = { defaults: { resource: 'hdwing' }, selectedSites: ['hdwing'] };
  let error: Error | undefined;
  const calls: unknown[] = [];
  const sites = [
    { site: 'mteam', enabled: true, status: 'configured_valid', version: 'a'.repeat(64), verifiedAt: null },
  ];
  const store: IntegrationPreferencesStore = {
    read: async () => structuredClone(row),
    setResourceAgent: async (_owner, device, selected) => {
      delete row.resourceAgentDeviceId;
      row = {
        ...row,
        resourceExecutionId: crypto.randomUUID(),
        ...(device ? { resourceAgentDeviceId: device, agentSelectedSites: selected } : {}),
      };
    },
    setDefault: async () => {},
    selectSites: async () => {},
    remove: async () => {},
  };
  const account: RemoteClientAccount = {
    key: { ownerId: 'alice', authVersion: 1, active: true, operations: [] },
    deviceLimit: 1,
  };
  const device: RemoteDeviceRecord = {
    ownerId: 'alice',
    deviceId: 'device-1',
    authVersion: 1,
    deviceVersion: 1,
    status: 'bound',
    isAgentOnline: true,
    isAgentDownloaderOnline: true,
    boundAt: new Date(),
    operations: [],
  };
  const service = new AgentResourceService({
    preferences: store,
    authorization: {
      account: async () => account,
      device: async (owner, id) => (owner === 'alice' && id === device.deviceId ? device : null),
    },
    gateway: {
      call: async <T>(_command: string, payload: unknown) => {
        calls.push(payload);
        if (error) throw error;
        const request = (payload as { request: { operation: string } }).request;
        return (
          request.operation === 'list'
            ? sites
            : request.operation === 'prepare'
              ? { agentTicket: '3912a4b4-5653-4afc-a286-b319337a38d2', torrentHash: 'a'.repeat(40) }
              : {
                  releases: [
                    { id: '123', title: 'Movie', seeders: 0 },
                    { id: '124', title: 'Unknown' },
                  ],
                }
        ) as T;
      },
    },
  });
  return {
    service,
    store,
    calls,
    sites,
    fail: (value?: Error) => {
      error = value;
    },
  };
}
test('redirected prepare retains the original cause and logs site context with verbose disabled', async () => {
  const f = fixture();
  await f.service.setMode('alice', 'device-1');
  const cause = new RpcError('AGENT_SITE_REDIRECTED', 'not_applied');
  f.fail(cause);
  const errors: Record<string, unknown>[] = [];
  const trace = new AiTrace({ error: (fields: Record<string, unknown>) => {
    errors.push(fields);
  } }, { correlationId: 'redirect-trace' }, '', 'gateway-rpc', false);
  await assert.rejects(
    withAiTrace(trace, () => f.service.prepare('alice', 'hdwing', '123', 'command-1', 'device-1', 'a'.repeat(64))),
    (error: unknown) => {
      assert.equal((error as { reason: string }).reason, 'redirected');
      assert.equal((error as Error).cause, cause);
      return true;
    }
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.site, 'hdwing');
  assert.equal(errors[0]!.resourceOperation, 'prepare');
  assert.equal(errors[0]!.resourceId, '123');
  assert.equal(errors[0]!.commandId, 'command-1');
  assert.equal(errors[0]!.deviceId, 'device-1');
  assert.equal(errors[0]!.rpcErrorCode, 'AGENT_SITE_REDIRECTED');
  assert.equal(errors[0]!.correlationId, 'redirect-trace');
});
test('Agent RPC errors preserve every mapped reason, HTTP status and original cause', async () => {
  const f = fixture();
  await f.service.setMode('alice', 'device-1');
  const cases = [
    ['AGENT_SITE_API_KEY_REQUIRED', 'apiKeyRequired', 502],
    ['AGENT_SITE_DOWNLOAD_EXPIRED', 'downloadExpired', 502],
    ['AGENT_SITE_AUTHENTICATION', 'authentication', 502],
    ['AGENT_SITE_ACCOUNT_CHANGED', 'authentication', 502],
    ['AGENT_SITE_NOT_CONFIGURED', 'notConfigured', 409],
    ['AGENT_SITE_BLOCKED', 'blocked', 502],
    ['AGENT_SITE_RATE_LIMITED', 'rateLimited', 502],
    ['AGENT_RESOURCE_BUSY', 'rateLimited', 502],
    ['AGENT_RESOURCE_TIMEOUT', 'timeout', 504],
    ['AGENT_SITE_TIMEOUT', 'timeout', 504],
    ['AGENT_RESOURCE_UNSUPPORTED', 'agentUnsupported', 503],
    ['AGENT_SITE_UNSUPPORTED', 'agentUnsupported', 503],
    ['AGENT_SITE_TARGET_CHANGED', 'agentModeConflict', 409],
    ['AGENT_SITE_DOWNLOAD_LIMITED', 'downloadLimited', 502],
    ['AGENT_RESOURCE_INVALID_RESPONSE', 'invalidResponse', 502],
    ['AGENT_SITE_INVALID_RESPONSE', 'invalidResponse', 502],
    ['AGENT_SITE_REDIRECTED', 'redirected', 502],
    ['DEVICE_OFFLINE', 'agentUnavailable', 503],
    ['UNKNOWN_ERROR', 'agentUnavailable', 503],
    ['__proto__', 'agentUnavailable', 503],
    ['toString', 'agentUnavailable', 503],
  ] as const;
  for (const [code, reason, statusCode] of cases) {
    const cause = new RpcError(code, 'not_applied');
    f.fail(cause);
    await assert.rejects(f.service.states('alice'), (error: unknown) => {
      assert.ok(error instanceof ResourceSiteError, code);
      assert.equal(error.reason, reason, code);
      assert.equal(error.statusCode, statusCode, code);
      assert.equal(error.cause, cause, code);
      return true;
    });
  }
  const cause = new Error('unexpected gateway failure');
  f.fail(cause);
  await assert.rejects(f.service.states('alice'), (error: unknown) => {
    assert.ok(error instanceof ResourceSiteError);
    assert.equal(error.reason, 'agentUnavailable');
    assert.equal(error.cause, cause);
    return true;
  });
});
test('local execution preserves cloud preferences and never falls back when offline', async () => {
  const f = fixture();
  let cloud = 0;
  const source = new AgentResourceSource(
    {
      id: 'mteam',
      name: 'M-Team',
      details: false,
      status: async () => 'configured_valid',
      search: async () => {
        cloud++;
        return { releases: [] };
      },
    },
    f.service
  );
  await f.service.setMode('alice', 'device-1');
  const result = await source.search('alice', { query: 'Movie' }, new AbortController().signal);
  assert.equal(result.releases[0]!.seeders, 0);
  assert.equal(result.releases[1]!.seeders, undefined);
  f.fail(new RpcError('DEVICE_OFFLINE', 'not_applied'));
  await assert.rejects(source.search('alice', { query: 'Movie' }, new AbortController().signal), {
    reason: 'agentUnavailable',
  });
  assert.equal(cloud, 0);
  assert.equal((await f.service.mode('alice')).unavailable, true);
  await f.service.setMode('alice', null);
  await source.search('alice', { query: 'Movie' }, new AbortController().signal);
  assert.equal(cloud, 1);
  assert.deepEqual((await f.store.read('alice')).defaults, { resource: 'hdwing' });
});
test('binding ownership, credentials and public response schema fail closed', async () => {
  const f = fixture();
  await assert.rejects(f.service.setMode('bob', 'device-1'), { reason: 'agentUnavailable' });
  assert.equal(f.calls.length, 0);
  await f.service.setMode('alice', 'device-1');
  f.fail(new RpcError('AGENT_SITE_TARGET_CHANGED', 'not_applied'));
  await assert.rejects(f.service.prepare('alice', 'mteam', '123', 'command-1', 'device-1', 'a'.repeat(64)), {
    reason: 'agentModeConflict',
  });
  f.fail();
  Object.assign(f.sites[0]!, { credential: 'must-not-pass' });
  await assert.rejects(f.service.states('alice'), { reason: 'invalidResponse' });
});
test('mode generation discards results across cloud to agent to cloud switches', async () => {
  const f = fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source = new AgentResourceSource(
    {
      id: 'mteam',
      name: 'M-Team',
      details: false,
      status: async () => 'configured_valid',
      search: async () => {
        await pending;
        return { releases: [] };
      },
    },
    f.service
  );
  const search = source.search('alice', { query: 'Movie' }, new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  await f.service.setMode('alice', 'device-1');
  await f.service.setMode('alice', null);
  release();
  await assert.rejects(search, { reason: 'agentModeConflict' });
});
test('agent download yields a ticket without resolving cloud credentials or reading a torrent in API', async () => {
  const f = fixture();
  await f.service.setMode('alice', 'device-1');
  const service = new RemoteTorrentService(
    {
      resolveRemote: async () => {
        throw Error('cloud fallback');
      },
    },
    async () => {
      throw Error('cloud metadata');
    }
  );
  service.agentResources = f.service;
  const command = {
    ownerId: 'alice',
    deviceId: 'device-1',
    commandId: 'command-1',
    source: 'mteam',
    resourceId: '123',
  };
  const pinned = { tmdbId: 1, resourceExecution: 'agent' as const, resourceCredentialVersion: 'a'.repeat(64) };
  const result = await service.resolve(command, pinned);
  assert.ok('agentTicket' in result);
  assert.equal(result.url, undefined);
  await assert.rejects(service.resolve({ ...command, deviceId: 'other-device' }, pinned), {
    reason: 'agentModeConflict',
  });
  await f.service.setMode('alice', null);
  await assert.rejects(service.resolve(command, pinned), { reason: 'agentModeConflict' });
});
