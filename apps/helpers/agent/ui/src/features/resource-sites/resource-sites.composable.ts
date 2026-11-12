import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import type { ResourceSiteClient, ResourceSiteEntry, ResourceSiteSnapshot } from './resource-sites.types';
import { canConfigureSite, sameSiteEndpoint } from './resource-sites.domain';

export function useResourceSites(client: ResourceSiteClient | undefined) {
  const entries = reactive<ResourceSiteEntry[]>([]);
  const loading = ref(false);
  const loaded = ref(false);
  const error = ref('');
  const dirty = computed(() =>
    entries.some((entry) => !!entry.credential || entry.baseUrl !== entry.snapshot.baseUrl)
  );
  const anyBusy = computed(() => entries.some((entry) => entry.busy));
  let active = true;
  let generation = 0;
  function apply(entry: ResourceSiteEntry, snapshot: ResourceSiteSnapshot) {
    entry.snapshot = snapshot;
    entry.baseUrl = snapshot.baseUrl;
    entry.credential = '';
    entry.editing = snapshot.status === 'unconfigured';
    entry.confirmingDelete = false;
  }
  async function load() {
    if (!client || loading.value || anyBusy.value) return;
    const current = ++generation;
    loading.value = true;
    error.value = '';
    try {
      const values = await client.list();
      if (!active || current !== generation) return;
      entries.forEach((entry) => {
        entry.credential = '';
      });
      entries.splice(
        0,
        entries.length,
        ...values.map((snapshot) => ({
          snapshot,
          baseUrl: snapshot.baseUrl,
          credential: '',
          editing: snapshot.status === 'unconfigured',
          confirmingDelete: false,
          busy: false,
          error: '',
        }))
      );
      loaded.value = true;
    } catch (cause) {
      if (active && current === generation) error.value = typeof cause === 'string' ? cause : 'unknownError';
    } finally {
      if (active && current === generation) loading.value = false;
    }
  }
  async function action(entry: ResourceSiteEntry, operation: () => Promise<ResourceSiteSnapshot | void>) {
    if (!client || entry.busy || loading.value || !active) return;
    entry.busy = true;
    entry.error = '';
    try {
      const snapshot = await operation();
      if (!active) return;
      apply(
        entry,
        snapshot ?? {
          ...entry.snapshot,
          enabled: false,
          status: 'unconfigured',
          hasCredential: false,
          verifiedAt: null,
          lastError: null,
        }
      );
    } catch (cause) {
      if (active) {
        entry.error = typeof cause === 'string' ? cause : 'unknownError';
        if (['siteAuthentication', 'siteBlocked', 'siteAccountChanged'].includes(entry.error) && !entry.editing) {
          entry.snapshot.status = 'configured_invalid';
          entry.snapshot.lastError = entry.error;
        }
      }
    } finally {
      if (active) entry.busy = false;
    }
  }
  async function setDefault(entry: ResourceSiteEntry) {
    if (!client?.setDefault || entry.busy || loading.value || anyBusy.value) return;
    entry.busy = true;
    entry.error = '';
    try {
      const snapshots = await client.setDefault(entry.snapshot.site);
      if (active) snapshots.forEach((snapshot) => {
        const row = entries.find((row) => row.snapshot.site === snapshot.site);
        if (row) row.snapshot.isDefault = snapshot.isDefault;
      });
    } catch (cause) {
      if (active) entry.error = typeof cause === 'string' ? cause : 'unknownError';
    } finally {
      if (active) entry.busy = false;
    }
  }
  function configure(entry: ResourceSiteEntry) {
    if (!client || !canConfigureSite(entry)) return;
    const keep = sameSiteEndpoint(entry);
    const request = {
      site: entry.snapshot.site,
      baseUrl: entry.baseUrl.trim(),
      credential: entry.credential ? { action: 'set' as const, value: entry.credential } : { action: 'keep' as const },

    };
    if (!keep && !entry.credential) return;
    return action(entry, () => client.configure(request));
  }
  function cancel(entry: ResourceSiteEntry) {
    if (entry.busy) return;
    apply(entry, entry.snapshot);
    entry.error = '';
  }
  function remove(entry: ResourceSiteEntry) {
    if (!client || !entry.confirmingDelete) return;
    return action(entry, () => client.remove(entry.snapshot.site));
  }
  function verify(entry: ResourceSiteEntry) {
    if (!client) return;
    return action(entry, () => client.verify(entry.snapshot.site));
  }
  function toggle(entry: ResourceSiteEntry) {
    if (!client) return;
    return action(entry, () => client.setEnabled(entry.snapshot.site, !entry.snapshot.enabled));
  }
  onBeforeUnmount(() => {
    active = false;
    generation++;
    entries.forEach((entry) => {
      entry.credential = '';
    });
  });
  return {
    entries,
    dirty,
    loading,
    loaded,
    error,
    available: !!client,
    anyBusy,
    load,
    configure,
    setDefault,
    canSetDefault: !!client?.setDefault,
    cancel,
    remove,
    verify,
    toggle,
  };
}
