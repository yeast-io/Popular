import type { ResourceSiteAdapter } from './resource-site.types.js';
import { HDAreaAdapter } from './hdarea/hdarea.adapter.js';
export function createResourceSiteRegistry(hdareaBaseUrl: string): ReadonlyMap<string, ResourceSiteAdapter> {
  const adapter = new HDAreaAdapter(hdareaBaseUrl);
  return new Map([[adapter.id, adapter]]);
}
