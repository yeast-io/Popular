import type { ResourceSearchSource } from '../resource-search/resource-search.types.js';
import type { ResourceSiteSearch } from '@movie-hub/contract';
import type { AgentResourceService } from './agent-resource.service.js';
import { ResourceSiteError } from '../resource-sites/resource-site.errors.js';

export class AgentResourceSource implements ResourceSearchSource {
  readonly id: string;
  readonly name: string;
  readonly details: boolean;

  constructor(private readonly cloud: ResourceSearchSource, private readonly agent: AgentResourceService) {
    this.id = cloud.id;
    this.name = cloud.name;
    this.details = cloud.details;
  }

  async status(ownerId: string) {
    return (await this.agent.enabled(ownerId)) ? this.agent.status(ownerId, this.id) : this.cloud.status(ownerId);
  }

  async search(ownerId: string, input: ResourceSiteSearch, signal: AbortSignal) {
    const execution = await this.agent.execution(ownerId);
    const device = execution.deviceId;
    const result = device
      ? await this.agent.search(ownerId, this.id, input, signal)
      : await this.cloud.search(ownerId, input, signal);
    if ((await this.agent.executionVersion(ownerId)) !== execution.key)
      throw new ResourceSiteError('agentModeConflict');
    return result;
  }

  async detail(ownerId: string, id: string, signal: AbortSignal) {
    const execution = await this.agent.execution(ownerId);
    const device = execution.deviceId;
    if (device) {
      const result = await this.agent.detail(ownerId, this.id, id, signal);
      if ((await this.agent.executionVersion(ownerId)) !== execution.key)
        throw new ResourceSiteError('agentModeConflict');
      return result;
    }
    if (!this.cloud.detail) throw new ResourceSiteError('invalidResponse');
    const result = await this.cloud.detail(ownerId, id, signal);
    if ((await this.agent.executionVersion(ownerId)) !== execution.key)
      throw new ResourceSiteError('agentModeConflict');
    return result;
  }
}
