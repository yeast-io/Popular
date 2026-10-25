import type { IntegrationPreferences, ResourceSiteSearchResult } from '@movie-hub/contract';
import type { ResourceQueryGroup } from './resource-query.types';
import { ref } from 'vue';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import { LocalizedApiError, localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';

export function useResourceQuery(query: () => string, mediaType: () => 'movie' | 'tv') {
  const { apiBaseUrl } = loadWebConfig();
  const { locale } = useI18n();
  const groups = ref<ResourceQueryGroup[]>([]);
  const loading = ref(false);
  const error = ref('');
  const defaultSite = ref('');
  const preferences = ref<IntegrationPreferences | null>(null);
  let controller: AbortController | undefined;
  let generation = 0;

  async function request<T>(path: string, signal: AbortSignal): Promise<T> {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      credentials: 'include', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: { 'accept-language': locale.value },
    });
    if (!response.ok) throw await localizedResponseError(response);
    return response.json() as Promise<T>;
  }

  async function loadGroup(group: ResourceQueryGroup, page = 1, refresh = false, cacheOnly = false) {
    if (group.loading || !controller || controller.signal.aborted) return;
    const current = generation;
    const signal = controller.signal;
    group.loading = true;
    group.error = '';
    group.retryPage = page;
    try {
      const params = new URLSearchParams({ query: query(), mediaType: mediaType(), page: String(page) });
      if (refresh) params.set('refresh', 'true');
      if (cacheOnly) params.set('cacheOnly', 'true');
      const result = await request<ResourceSiteSearchResult>(`/me/resource-search/${encodeURIComponent(group.site)}/releases?${params}`, signal);
      if (current !== generation || signal.aborted) return;
      if (result.cacheMiss) {
        delete group.result;
        return;
      }
      if (page === 1) group.releasePages = {};
      group.releasePages ??= {};
      for (const release of result.releases) group.releasePages[release.id] = page;
      if (page > 1 && group.result) {
        const known = new Set(group.result.releases.map((release) => release.id));
        result.releases = [...group.result.releases, ...result.releases.filter((release) => !known.has(release.id))];
      }
      group.result = result;
      group.queriedAt = result.queriedAt ?? new Date().toISOString();
    } catch (cause) {
      if (current === generation && !signal.aborted) {
        if (cause instanceof LocalizedApiError && cause.code === 'RESOURCE_REFRESH_RATE_LIMITED' && cause.retryAfterSeconds !== undefined)
          group.refreshAvailableAt = Date.now() + cause.retryAfterSeconds * 1000;
        else group.error = localizedErrorMessage(cause, 'resourceQuery.error');
      }
    } finally {
      if (current === generation) group.loading = false;
    }
  }

  async function load(cacheOnly = false) {
    const current = ++generation;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    groups.value = [];
    loading.value = true;
    error.value = '';
    try {
      const currentPreferences = await request<IntegrationPreferences>('/me/integration-preferences', signal);
      if (current !== generation || signal.aborted) return;
      preferences.value = currentPreferences;
      defaultSite.value = currentPreferences.defaults.resource ?? '';
      const sites = [...new Set(preferences.value.effectiveSites)].sort((a, b) => Number(b === defaultSite.value) - Number(a === defaultSite.value));
      groups.value = sites.map((site) => ({
        site, name: currentPreferences.choices.find((choice) => choice.category === 'resource' && choice.id === site)?.name ?? site,
        loading: false, error: '', retryPage: 1,
      }));
      await Promise.all(groups.value.map((group) => loadGroup(group, 1, false, cacheOnly)));
    } catch (cause) {
      if (current === generation && !signal.aborted) error.value = localizedErrorMessage(cause, 'resourceQuery.error');
    } finally {
      if (current === generation) loading.value = false;
    }
  }

  function cancel() {
    ++generation;
    controller?.abort();
    loading.value = false;
    for (const group of groups.value) group.loading = false;
  }
  function clear() {
    cancel();
    groups.value = [];
    loading.value = false;
    error.value = '';
    defaultSite.value = '';
  }
  return { groups, loading, error, defaultSite, preferences, load, loadGroup, clear, cancel };
}
