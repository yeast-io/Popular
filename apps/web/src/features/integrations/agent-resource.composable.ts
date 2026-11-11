import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { AgentResourceModeResponse, RemoteClientDevice } from '@movie-hub/contract';
import { useI18n } from '../../i18n';
import { loadWebConfig } from '../../config/env';
import { localizedErrorMessage } from '../../i18n/api-error';
import { createAgentResourceClient } from './agent-resource.client';

export function useAgentResources() {
  const { locale } = useI18n();
  const client = createAgentResourceClient(loadWebConfig().apiBaseUrl, () => locale.value);
  const mode = ref<AgentResourceModeResponse>({ deviceId: null });
  const devices = ref<RemoteClientDevice[]>([]);
  const selectedDevice = ref('');
  const loading = ref(false);
  const loaded = ref(false);
  const busy = ref(false);
  const error = ref('');
  const enabled = computed(() => mode.value.deviceId !== null);
  const controller = new AbortController();
  let active = true;
  let revision = 0;
  async function load() {
    if (loading.value || busy.value || !active) return;
    const current = ++revision;
    loading.value = true;
    error.value = '';
    try {
      const result = await client.mode(controller.signal);
      if (!active || current !== revision) return;
      mode.value = result;
      selectedDevice.value = result.deviceId ?? selectedDevice.value;
      loaded.value = true;
      try {
        const remote = await client.devices(controller.signal);
        if (!active || current !== revision) return;
        devices.value = remote.hasKey ? remote.devices : [];
        if (!selectedDevice.value && devices.value.length === 1) selectedDevice.value = devices.value[0]!.id;
      } catch (cause) {
        if (active && current === revision) error.value = localizedErrorMessage(cause, 'errors.requestFailed');
      }
    } catch (cause) {
      if (active && current === revision) error.value = localizedErrorMessage(cause, 'errors.requestFailed');
    } finally {
      if (active && current === revision) loading.value = false;
    }
  }
  async function toggle() {
    if (busy.value || !loaded.value || (!enabled.value && !selectedDevice.value)) return;
    busy.value = true;
    error.value = '';
    const current = ++revision;
    try {
      const result = await client.save(enabled.value ? null : selectedDevice.value, controller.signal);
      if (!active || current !== revision) return;
      mode.value = result;
      window.dispatchEvent(new Event('integration-preferences-changed'));
    } catch (cause) {
      if (active && current === revision) error.value = localizedErrorMessage(cause, 'errors.requestFailed');
    } finally {
      if (active && current === revision) busy.value = false;
    }
  }
  onMounted(() => {
    void load();
  });
  onBeforeUnmount(() => {
    active = false;
    revision++;
    controller.abort();
  });
  return { mode, devices, selectedDevice, loading, loaded, busy, error, enabled, load, toggle };
}
