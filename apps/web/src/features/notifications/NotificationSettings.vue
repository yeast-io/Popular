<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { NotificationPreferences, SaveNotificationPreferences } from '@movie-hub/contract';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import { localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';

const { apiBaseUrl } = loadWebConfig();
const { t, locale } = useI18n();
const draft = ref<SaveNotificationPreferences>({ enabled: false, defaultChannel: 'whatsapp', additionalChannels: [] });
const channels = ref<NotificationPreferences['channels']>([]);
const loading = ref(true);
const initialized = ref(false);
const busy = ref(false);
const error = ref('');
const saved = ref(false);
const enabledChannels = computed(() => {
  return draft.value.enabled ? [draft.value.defaultChannel, ...draft.value.additionalChannels] : [];
});
let disposed = false;
const controller = new AbortController();
async function request(method = 'GET') {
  const response = await fetch(`${apiBaseUrl}/me/notifications`, {
    method, credentials: 'include', signal: controller.signal,
    headers: { 'accept-language': locale.value, ...(method === 'PUT' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'PUT' ? { body: JSON.stringify(draft.value) } : {}),
  });
  if (!response.ok) throw await localizedResponseError(response);
  return (await response.json()) as NotificationPreferences;
}
function adopt(result: NotificationPreferences) {
  draft.value = { enabled: result.enabled, defaultChannel: result.defaultChannel, additionalChannels: result.additionalChannels };
}
async function refresh(availabilityOnly = true) {
  try {
    const result = await request();
    if (disposed) return;
    channels.value = result.channels;
    if (!availabilityOnly) {
      adopt(result);
      initialized.value = true;
    }
  } catch (cause) {
    if (!disposed) error.value = localizedErrorMessage(cause, 'errors.requestFailed');
  } finally {
    if (!disposed && !availabilityOnly) loading.value = false;
  }
}
async function toggleChannel(id: string, enabled: boolean) {
  if (busy.value || loading.value || !initialized.value || !channels.value.find((channel) => {
    return channel.id === id;
  })?.configured) return;
  const previous = draft.value;
  const selected = enabledChannels.value.filter((channelId) => {
    return channels.value.find((channel) => channel.id === channelId)?.configured;
  });
  const next = enabled ? [...new Set([...selected, id])] : selected.filter((channelId) => channelId !== id);
  const defaultChannel = next.includes(previous.defaultChannel) ? previous.defaultChannel : next[0] ?? previous.defaultChannel;
  draft.value = { enabled: next.length > 0, defaultChannel, additionalChannels: next.filter((channelId) => {
    return channelId !== defaultChannel;
  }) };
  busy.value = true;
  error.value = '';
  saved.value = false;
  try {
    const result = await request('PUT');
    if (disposed) return;
    adopt(result);
    channels.value = result.channels;
    saved.value = true;
  } catch (cause) {
    if (!disposed) {
      draft.value = previous;
      error.value = localizedErrorMessage(cause, 'errors.requestFailed');
    }
  } finally {
    if (!disposed) busy.value = false;
  }
}
defineExpose({ refresh });
onMounted(() => { void refresh(false); });
onUnmounted(() => {
  disposed = true;
  controller.abort();
});
</script>
<template>
  <section class="notification-preferences" :aria-busy="loading || busy" :aria-label="t('notifications.title')">
    <p v-if="loading" role="status">{{ t('notifications.loading') }}</p>
    <div class="notification-channel-cards">
      <slot :enabled-channels="enabledChannels" :disabled="loading || busy || !initialized" :toggle-channel="toggleChannel" />
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="saved" class="success" role="status">{{ t('notifications.saved') }}</p>
  </section>
</template>
<style scoped>
.notification-preferences, .notification-channel-cards { display: grid; gap: 16px; min-width: 0; }
.notification-preferences > p { margin: 0; font-size: .75rem; }
</style>
