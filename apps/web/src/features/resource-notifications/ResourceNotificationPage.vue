<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { ResourceNotificationItem, ResourceNotificationList } from '@movie-hub/contract';
import { useI18n } from '../../i18n';
import { localizedErrorMessage } from '../../i18n/api-error';
import ResourceNotificationInfo from './ResourceNotificationInfo.vue';
import { resourceNotificationRequest } from './resource-notification.client';

const emit = defineEmits<{ openMovie: [tmdbId: number]; openTvShow: [tmdbId: number] }>();
const { t, locale, formatDate } = useI18n();
const failedPosters = ref(new Set<string>());
function statusIcon(item: ResourceNotificationItem) {
  if (item.status === 'notified') return 'check' as const;
  if (item.lastOutcome === 'failed' || item.lastOutcome === 'no-channels') return 'warning' as const;
  return item.lastOutcome === 'no-resources' ? 'search' as const : 'info' as const;
}
const items = ref<ResourceNotificationItem[]>([]);
const limit = ref<number | null>(null);
const full = computed(() => limit.value !== null && items.value.length >= limit.value);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
let controller: AbortController | undefined;
let version = 0;
async function load() {
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  const current = ++version;
  loading.value = true;
  error.value = '';
  try {
    const result = await resourceNotificationRequest<ResourceNotificationList>(`?locale=${locale.value}`, { signal });
    if (current === version) {
      items.value = result.items;
      limit.value = result.limit;
    }
  } catch (cause) {
    if (current === version && !signal.aborted)
      error.value = localizedErrorMessage(cause, 'resourceNotifications.error');
  } finally {
    if (current === version) loading.value = false;
  }
}
async function remove(item: ResourceNotificationItem) {
  if (saving.value) return;
  saving.value = true;
  const current = version;
  try {
    await resourceNotificationRequest(`/${item.mediaType}/${item.tmdbId}`, {
      method: 'DELETE',
      signal: controller?.signal ?? null,
    });
    if (current === version) await load();
  } catch (cause) {
    if (current === version && !controller?.signal.aborted)
      error.value = localizedErrorMessage(cause, 'resourceNotifications.error');
  } finally {
    saving.value = false;
  }
}
function status(entry: ResourceNotificationItem) {
  if (entry?.status === 'notified') return t('resourceNotifications.notified');
  if (entry?.lastOutcome === 'no-channels') return t('resourceNotifications.noChannels');
  if (entry?.lastOutcome === 'failed') return t('resourceNotifications.failed');
  if (entry?.lastOutcome === 'no-resources') return t('resourceNotifications.noResources');
  return t('resourceNotifications.notChecked');
}
function open(item: ResourceNotificationItem) {
  if (item.mediaType === 'movie') emit('openMovie', item.tmdbId);
  else emit('openTvShow', item.tmdbId);
}
watch(
  locale,
  () => {
    void load();
  },
  { immediate: true }
);
onBeforeUnmount(() => {
  ++version;
  controller?.abort();
});
</script>

<template>
  <section class="movie-section resource-notification-page" :aria-label="t('resourceNotifications.title')">
    <header class="resource-notification-header">
      <div class="resource-notification-heading">
        <h1>{{ t('resourceNotifications.title') }}</h1>
        <div v-if="limit !== null" class="resource-notification-quota" :class="{ full }" role="status" aria-live="polite"
          :title="t('resourceNotifications.quotaHint')" :aria-description="t('resourceNotifications.quotaHint')"
          :aria-label="t(full ? 'resourceNotifications.quotaFull' : 'resourceNotifications.quotaUsed', { count: items.length, limit })">
          <span>{{ t(full ? 'resourceNotifications.quotaFullLabel' : 'resourceNotifications.quotaLabel') }}</span>
          <strong>{{ items.length }} / {{ limit }}</strong>
        </div>
      </div>
      <p v-if="full" class="resource-notification-quota-hint full">
        {{ t('resourceNotifications.quotaFullHint') }}
      </p>
    </header>
    <p v-if="loading" class="movie-state" role="status">{{ t('resourceNotifications.loading') }}</p>
    <div v-if="error" class="movie-state" role="alert">
      <p>{{ error }}</p>
      <button class="outline-button" type="button" :disabled="loading" @click="load">{{ t('actions.retry') }}</button>
    </div>
    <p v-if="!loading && !error && !items.length" class="movie-state">{{ t('resourceNotifications.empty') }}</p>
    <div class="resource-notification-list">
      <article v-for="item in items" :key="item.id" class="resource-notification-card">
        <button class="resource-notification-entry" type="button" :aria-label="t('watchlist.open', { title: item.title })" @click="open(item)">
          <span class="resource-notification-poster">
            <img v-if="item.posterUrl && !failedPosters.has(item.id)" :src="item.posterUrl" alt="" loading="lazy" @error="failedPosters.add(item.id)" />
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M4 8h16M4 16h16M8 3v5m8-5v5M8 16v5m8-5v5" /></svg>
          </span>
          <span class="resource-notification-copy">
            <strong class="resource-notification-title" :title="item.title">{{ item.title }}</strong>
            <span class="resource-notification-metadata">
              <span>{{ t(item.mediaType === 'movie' ? 'nav.movies' : 'nav.tvShows') }}</span>
              <time v-if="item.releaseDate" :datetime="item.releaseDate">{{ formatDate(item.releaseDate) }}</time>
            </span>
            <span v-if="item.overview?.trim()" class="resource-notification-overview">{{ item.overview }}</span>
          </span>
        </button>
        <div class="resource-notification-actions">
          <ResourceNotificationInfo class="resource-notification-status" :label="status(item)"
            :icon="statusIcon(item)"
            :tone="item.status === 'notified' ? 'notified' : item.lastOutcome === 'failed' || item.lastOutcome === 'no-channels' ? 'warning' : undefined" />
          <ResourceNotificationInfo v-if="item.status !== 'notified' && item.nextCheckAt && Number.isFinite(Date.parse(item.nextCheckAt))"
            class="resource-notification-next-check" icon="clock"
            :label="`${t('resourceNotifications.nextCheck')} · ${formatDate(item.nextCheckAt, { dateStyle: 'full', timeStyle: 'short' })}`" />
        <button class="resource-notification-remove" type="button" :disabled="saving || loading"
          :aria-label="t('resourceNotifications.removeTitle', { title: item.title })" :title="t('resourceNotifications.remove')" @click="remove(item)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6" /></svg>
        </button>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.resource-notification-header { margin-bottom: 24px; }
.resource-notification-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 12px 20px; }
.resource-notification-page h1 { margin: 0; font-size: 24px; }
.resource-notification-quota { display: inline-flex; align-items: center; gap: 10px; padding: 7px 12px; border: 1px solid #555b63; border-radius: 8px; background: #a7acb210; color: #c5cad1; font-size: 12px; line-height: 1.4; }
.resource-notification-quota strong { color: #f0f1f3; font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; white-space: nowrap; }
.resource-notification-quota.full { border-color: #e8a36980; background: #e8a36918; color: #f0b886; }
.resource-notification-quota.full strong { color: #ffc18e; }
.resource-notification-quota-hint { margin: 6px 0 0; color: #8d949d; font-size: 12px; line-height: 1.6; }
.resource-notification-quota-hint.full { color: #f0b886; }
.resource-notification-list { display: grid; gap: 12px; }
.resource-notification-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 16px; padding: 12px 16px 12px 12px; border: 1px solid #35383b; border-radius: 10px; background: rgba(19, 21, 23, .8); transition: border-color .2s ease, background .2s ease; }
.resource-notification-card:has(.resource-notification-entry:hover) { border-color: #786057; background: rgba(27, 28, 30, .95); }
.resource-notification-entry { display: grid; grid-template-columns: 72px minmax(0, 1fr); align-items: center; gap: 20px; min-width: 0; width: 100%; padding: 0; border: 0; border-radius: 4px; background: transparent; color: #eee; font: inherit; text-align: left; cursor: pointer; }
.resource-notification-entry:focus-visible, .resource-notification-remove:focus-visible { outline: 2px solid var(--brand); outline-offset: 4px; }
.resource-notification-poster { display: grid; place-items: center; width: 72px; height: 108px; overflow: hidden; border-radius: 5px; background: #24272b; color: #737a83; }
.resource-notification-poster img { display: block; width: 100%; height: 100%; object-fit: cover; }
.resource-notification-poster > svg { width: 28px; height: 28px; }
.resource-notification-copy { display: grid; gap: 8px; min-width: 0; }
.resource-notification-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; line-height: 1.5; }
.resource-notification-metadata { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; color: #a7acb2; font-size: 12px; line-height: 1.5; }
.resource-notification-overview { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; color: #a7acb2; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.resource-notification-actions { position: relative; display: flex; align-items: center; justify-content: end; gap: 4px; }
.resource-notification-remove { display: grid; place-items: center; width: 40px; height: 40px; min-height: 0; padding: 0; border: 1px solid transparent; border-radius: 6px; background: transparent; color: #858a91; cursor: pointer; transition: color .2s ease, background .2s ease, border-color .2s ease; }
.resource-notification-remove svg { width: 18px; height: 18px; }
.resource-notification-remove:hover:not(:disabled) { border-color: #bd665c40; background: #bd665c1a; color: #df8b80; }
.resource-notification-remove:disabled { opacity: .4; cursor: not-allowed; }
@media (max-width: 600px) {
  .resource-notification-card { grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 10px; }
  .resource-notification-entry { grid-template-columns: 72px minmax(0, 1fr); gap: 8px 12px; }
  .resource-notification-poster { grid-row: 1; }
  .resource-notification-copy { align-self: end; gap: 5px; }
  .resource-notification-title { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: normal; overflow-wrap: anywhere; font-size: 14px; }
  .resource-notification-actions { justify-self: end; }
  .resource-notification-remove { width: 44px; height: 44px; }
}
</style>
