import { Value } from '@sinclair/typebox/value';
import { AgentResourceRequestSchema, AgentResourceResultSchemas } from '@movie-hub/contract';
import type {
  AgentResourceRequest,
  AgentResourceSites,
  AgentPreparedTorrent,
  ResourceSiteSearch,
  ResourceSiteSearchResult,
  ResourceSiteRelease,
  AgentResourceModeResponse,
} from '@movie-hub/contract';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import { ResourceSiteError } from '../resource-sites/resource-site.errors.js';
import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { releaseTitleMetadata } from '../resource-sites/release-metadata.domain.js';
import { releaseTags } from '../resource-sites/release-tags.domain.js';
import type { AgentResourceDependencies } from './agent-resource.types.js';

export class AgentResourceService {
  private readonly pending = new Map<string, Promise<AgentResourceSites>>();

  constructor(private readonly dependencies: AgentResourceDependencies) {}

  async execution(ownerId: string) {
    const row = await this.dependencies.preferences.read(ownerId);
    return {
      deviceId: row.resourceAgentDeviceId,
      key: `${row.resourceAgentDeviceId ?? 'cloud'}:${row.resourceExecutionId ?? 'legacy'}`,
    };
  }

  async device(ownerId: string): Promise<string | undefined> {
    return (await this.execution(ownerId)).deviceId;
  }

  async executionVersion(ownerId: string): Promise<string> {
    return (await this.execution(ownerId)).key;
  }

  async enabled(ownerId: string): Promise<boolean> {
    return !!(await this.device(ownerId));
  }

  async mode(ownerId: string): Promise<AgentResourceModeResponse> {
    const deviceId = await this.device(ownerId);
    if (!deviceId) return { deviceId: null };
    try {
      return { deviceId, sites: await this.states(ownerId) };
    } catch (error) {
      currentAiTrace()?.fail(error, { stage: 'agent-resource.mode.status' });
      currentAiTrace()?.clearFailure();
      return { deviceId, unavailable: true };
    }
  }

  async setMode(ownerId: string, deviceId: string | null): Promise<AgentResourceModeResponse> {
    const store = this.dependencies.preferences;
    if (!store.setResourceAgent) throw new ResourceSiteError('agentUnavailable');
    const sites = deviceId
      ? await this.execute<AgentResourceSites>(ownerId, { operation: 'list' }, deviceId)
      : undefined;
    await aiStep('agent-resource.mode.save', () =>
      store.setResourceAgent!(
        ownerId,
        deviceId,
        sites?.filter((site) => site.enabled && site.status === 'configured_valid').map((site) => site.site) ?? []
      )
    );
    return { deviceId, ...(sites ? { sites } : {}) };
  }

  async execute<T>(ownerId: string, request: AgentResourceRequest, selectedDevice?: string): Promise<T> {
    if (!Value.Check(AgentResourceRequestSchema, request)) throw new ResourceSiteError('invalidResponse');
    const deviceId = selectedDevice ?? (await this.device(ownerId));
    if (!deviceId) throw new ResourceSiteError('agentModeConflict');
    const [account, device] = await Promise.all([
      this.dependencies.authorization.account(ownerId),
      this.dependencies.authorization.device(ownerId, deviceId),
    ]);
    if (!account.key?.active || !device || device.status !== 'bound' || device.authVersion !== account.key.authVersion)
      throw new ResourceSiteError('agentUnavailable');
    try {
      const result = await aiStep('agent-resource.gateway.request', () =>
        this.dependencies.gateway.call(
          '__agent_resource__',
          {
            ownerId,
            deviceId,
            authVersion: device.authVersion,
            deviceVersion: device.deviceVersion,
            request,
          },
          currentAiTrace()?.correlationId
        )
      );
      if (!Value.Check(AgentResourceResultSchemas[request.operation], result))
        throw new ResourceSiteError('invalidResponse');
      return result as T;
    } catch (cause) {
      if (cause instanceof ResourceSiteError) throw cause;
      const code = cause instanceof RpcError ? cause.code : '';
      const reason
        = code === 'AGENT_SITE_AUTHENTICATION' || code === 'AGENT_SITE_ACCOUNT_CHANGED'
          ? 'authentication'
          : code === 'AGENT_SITE_NOT_CONFIGURED'
            ? 'notConfigured'
            : code === 'AGENT_SITE_BLOCKED'
              ? 'blocked'
              : code === 'AGENT_SITE_RATE_LIMITED' || code === 'AGENT_RESOURCE_BUSY'
                ? 'rateLimited'
                : code === 'AGENT_RESOURCE_TIMEOUT' || code === 'AGENT_SITE_TIMEOUT'
                  ? 'timeout'
                  : code === 'AGENT_RESOURCE_UNSUPPORTED' || code === 'AGENT_SITE_UNSUPPORTED'
                    ? 'agentUnsupported'
                    : code === 'AGENT_SITE_TARGET_CHANGED'
                      ? 'agentModeConflict'
                      : code === 'AGENT_SITE_DOWNLOAD_LIMITED'
                        ? 'downloadLimited'
                        : code === 'AGENT_RESOURCE_INVALID_RESPONSE' || code === 'AGENT_SITE_INVALID_RESPONSE'
                          ? 'invalidResponse'
                          : 'agentUnavailable';
      throw new ResourceSiteError(reason, { cause });
    }
  }

  async states(ownerId: string): Promise<AgentResourceSites> {
    const execution = await this.execution(ownerId);
    if (!execution.deviceId) throw new ResourceSiteError('agentModeConflict');
    const key = `${ownerId}:${execution.key}`;
    const prior = this.pending.get(key);
    if (prior) return prior;
    const task = this.execute<AgentResourceSites>(ownerId, { operation: 'list' }, execution.deviceId).finally(() => {
      if (this.pending.get(key) === task) this.pending.delete(key);
    });
    this.pending.set(key, task);
    return task;
  }

  async status(ownerId: string, site: string) {
    try {
      const row = (await this.states(ownerId)).find((row) => row.site === site);
      return !row?.enabled ? ('unconfigured' as const) : row.status;
    } catch (error) {
      currentAiTrace()?.fail(error, { stage: 'agent-resource.status', site });
      currentAiTrace()?.clearFailure();
      return 'configured_invalid' as const;
    }
  }

  async cacheVersion(ownerId: string, site: string): Promise<string> {
    const execution = await this.execution(ownerId);
    const row = (await this.states(ownerId)).find((row) => row.site === site);
    if ((await this.executionVersion(ownerId)) !== execution.key) throw new ResourceSiteError('agentModeConflict');
    return `agent:${execution.key}:${site}:${row?.version ?? ''}:${row?.enabled ?? false}:${row?.status ?? 'unconfigured'}`;
  }

  async configuration(ownerId: string, site: string) {
    const row = (await this.states(ownerId)).find((row) => row.site === site);
    return {
      site,
      status: row?.enabled ? row.status : ('unconfigured' as const),
      ...(row?.baseUrl ? { baseUrl: row.baseUrl } : {}),
      ...(row?.verifiedAt ? { verifiedAt: new Date(row.verifiedAt).toISOString() } : {}),
    };
  }

  async search(
    ownerId: string,
    site: string,
    input: ResourceSiteSearch,
    signal: AbortSignal
  ): Promise<ResourceSiteSearchResult> {
    signal.throwIfAborted();
    const result = await this.execute<ResourceSiteSearchResult>(ownerId, {
      operation: 'search',
      site: this.site(site),
      ...(input.query ? { query: input.query } : {}),
      ...(input.imdbId ? { imdbId: input.imdbId } : {}),
      ...(input.page ? { page: input.page } : {}),
      ...(input.mediaType ? { mediaType: input.mediaType } : {}),
    });
    signal.throwIfAborted();
    return { ...result, releases: result.releases.map((release) => this.metadata(release)) };
  }

  async detail(ownerId: string, site: string, resourceId: string, signal: AbortSignal): Promise<ResourceSiteRelease> {
    signal.throwIfAborted();
    const result = await this.execute<ResourceSiteRelease>(ownerId, {
      operation: 'detail',
      site: this.site(site),
      resourceId,
    });
    signal.throwIfAborted();
    return this.metadata(result);
  }

  prepare(
    ownerId: string,
    site: string,
    resourceId: string,
    commandId: string,
    deviceId: string,
    version: string
  ): Promise<AgentPreparedTorrent> {
    return this.execute(
      ownerId,
      { operation: 'prepare', site: this.site(site), resourceId, commandId, version },
      deviceId
    );
  }

  private site(site: string): 'mteam' | 'hdarea' | 'hdwing' {
    if (site !== 'mteam' && site !== 'hdarea' && site !== 'hdwing') throw new ResourceSiteError('notConfigured');
    return site;
  }

  private metadata(release: ResourceSiteRelease): ResourceSiteRelease {
    return {
      ...release,
      ...releaseTitleMetadata(release.title),
      tags: releaseTags(release.title, release.description ?? '', ...(release.tags ?? [])),
    };
  }
}
