<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type { ResourceNotificationMembership, WatchlistMediaType } from '@movie-hub/contract';
import { useI18n } from '../../i18n';
import { LocalizedApiError, localizedErrorMessage } from '../../i18n/api-error';
import type { ResourceNotificationFeedback } from './resource-notification.types';
import { resourceNotificationRequest } from './resource-notification.client';

const props = defineProps<{ mediaType: WatchlistMediaType; tmdbId: number; authenticated: boolean }>();
const emit = defineEmits<{ requireLogin: []; feedback: [value: ResourceNotificationFeedback | null] }>();
const { t, locale } = useI18n();
const membership = ref<ResourceNotificationMembership>({ enabled: false });
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const needsChannel = ref(false);
const loadFailed = ref(false);
let controller: AbortController | undefined;
let version = 0;

async function load() {
  controller?.abort();
  const current = ++version;
  membership.value = { enabled: false };
  error.value = '';
  needsChannel.value = false;
  loadFailed.value = false;
  saving.value = false;
  loading.value = false;
  if (!props.authenticated) return;
  controller = new AbortController();
  const signal = controller.signal;
  loading.value = true;
  try {
    const result = await resourceNotificationRequest<ResourceNotificationMembership>(
      `/${props.mediaType}/${props.tmdbId}`,
      { signal }
    );
    if (version === current) membership.value = result;
  } catch (cause) {
    if (version === current && !signal.aborted) {
      loadFailed.value = true;
      error.value = localizedErrorMessage(cause, 'resourceNotifications.error');
    }
  } finally {
    if (version === current) loading.value = false;
  }
}

async function toggle() {
  if (!props.authenticated) {
    emit('requireLogin');
    return;
  }
  if (loading.value || saving.value) return;
  if (loadFailed.value) {
    await load();
    return;
  }
  const current = version;
  saving.value = true;
  error.value = '';
  needsChannel.value = false;
  try {
    const result = await resourceNotificationRequest<ResourceNotificationMembership>(
      `/${props.mediaType}/${props.tmdbId}?locale=${locale.value}`,
      {
        method: membership.value.enabled ? 'DELETE' : 'PUT',
        signal: controller?.signal ?? null,
      }
    );
    if (version === current) membership.value = result;
  } catch (cause) {
    if (version === current && !controller?.signal.aborted) {
      needsChannel.value
        = cause instanceof LocalizedApiError && cause.code === 'RESOURCE_NOTIFICATION_CHANNEL_REQUIRED';
      error.value = localizedErrorMessage(cause, 'resourceNotifications.error');
    }
  } finally {
    if (version === current) saving.value = false;
  }
}
watch([error, needsChannel], () => {
  emit('feedback', error.value ? { message: error.value, needsChannel: needsChannel.value } : null);
}, { immediate: true });
watch(
  () => [props.mediaType, props.tmdbId, props.authenticated, locale.value],
  () => {
    void load();
  },
  { immediate: true }
);
onBeforeUnmount(() => {
  ++version;
  controller?.abort();
  emit('feedback', null);
});
</script>

<template>
    <button
      type="button"
      class="detail-state-icon resource-notification-button"
      :class="{ active: membership.enabled }"
      :disabled="loading || saving"
      :aria-pressed="membership.enabled"
      :aria-busy="loading || saving"
      :aria-label="
        t(
          loadFailed
            ? 'actions.retry'
            : membership.enabled
              ? 'resourceNotifications.remove'
              : 'resourceNotifications.add',
        )
      "
      :title="
        t(
          membership.status === 'notified'
            ? 'resourceNotifications.notified'
            : membership.enabled
              ? 'resourceNotifications.pending'
              : 'resourceNotifications.add',
        )
      "
      @click="toggle"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        <path v-if="membership.status === 'notified'" d="m9 10 2 2 4-4" />
      </svg>
    </button>
</template>
