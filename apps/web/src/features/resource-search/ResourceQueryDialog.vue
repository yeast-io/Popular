<script setup lang="ts">
import { resourceSiteIconStyle } from '../movies/resource-site.presentation';
import type { ResourceQuerySession } from './resource-query.types';
import { useResourceQuery } from './resource-query.client';
import { onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { useI18n } from '../../i18n';

const props = defineProps<{ title: string; query: string; mediaType: 'movie' | 'tv'; session?: ResourceQuerySession; backdropUrl?: string | undefined; posterUrl?: string | undefined }>();
const emit = defineEmits<{ close: [] }>();
const { t, locale, formatNumber, formatDate } = useI18n();
const dialog = ref<HTMLDialogElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const titleId = useId();
const session = props.session ?? useResourceQuery(() => props.query, () => props.mediaType);
const { groups, loading, error, defaultSite, load, loadGroup } = session;
let trigger: HTMLElement | null = null;
let previousOverflow = '';

function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const unit = bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${formatNumber(bytes / 1024 ** unit, { maximumFractionDigits: 2 })} ${units[unit]}`;
}

watch([() => props.query, () => props.mediaType, locale], () => {
  if (!props.session) void load();
});
onMounted(() => {
  trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  dialog.value?.showModal();
  closeButton.value?.focus();
  if (!props.session) void load();
});
onBeforeUnmount(() => {
  if (!props.session) session.clear();
  else session.cancel();
  dialog.value?.close();
  document.body.style.overflow = previousOverflow;
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
});
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="release-panel resource-query-dialog"
      :style="{ '--resource-artwork': backdropUrl || posterUrl ? `url(${JSON.stringify(backdropUrl || posterUrl)})` : undefined }"
      :aria-labelledby="titleId"
      @cancel.prevent="emit('close')" @click.self="emit('close')">
      <header class="release-panel-heading">
        <div><p class="eyebrow">{{ t('resourceSelection.sources') }}</p><h2 :id="titleId">{{ title }}</h2></div>
        <button ref="closeButton" class="text-button" type="button" @click="emit('close')">{{ t('movie.releases.close') }}</button>
      </header>
      <div class="release-panel-content">
        <p v-if="loading && !groups.length" class="muted-copy" role="status">{{ t('resourceQuery.loading') }}</p>
        <p v-if="error" class="browse-error" role="alert">{{ error }} <button class="text-button" type="button" @click="load">{{ t('actions.retry') }}</button></p>
        <p v-if="!loading && !error && !groups.length" class="muted-copy">{{ t('resourceSelection.none') }}</p>
        <details v-for="group in groups" :key="group.site" class="release-site-group" open>
          <summary>
            <strong class="release-site-identity">
              <span class="resource-site-outline" :style="resourceSiteIconStyle(group.site)" aria-hidden="true" />
              {{ group.name }}
            </strong>
            <span v-if="group.site === defaultSite" class="integration-default-badge">{{ t('integrationDefaults.default') }}</span>
            <span class="release-site-status">{{ group.loading ? t('resourceQuery.loading') : group.error ? t('movie.resource.checkFailed') : t('resourceSelection.releaseCount', { count: group.result?.releases.length ?? 0 }) }}</span>
            <button class="release-site-refresh" type="button" :disabled="group.loading" :aria-label="t('resourceSelection.refreshSite', { name: group.name })"
              @click.stop.prevent="loadGroup(group)">{{ t('resourceSelection.refresh') }}</button>
          </summary>
          <div class="release-site-content" :aria-busy="group.loading">
            <p v-if="group.loading && !group.result" class="muted-copy" role="status">{{ t('resourceQuery.loading') }}</p>
            <p v-if="group.error" class="browse-error" role="alert">{{ group.error }} <button class="text-button" type="button" :disabled="group.loading" @click="loadGroup(group, group.retryPage)">{{ t('actions.retry') }}</button></p>
            <p v-if="group.queriedAt" class="release-query-time">{{ t(group.error ? 'resourceSelection.staleResults' : 'resourceSelection.queriedAt', { date: formatDate(group.queriedAt, { dateStyle: 'short', timeStyle: 'short' }) }) }}</p>
            <p v-if="group.result && !group.result.releases.length && !group.loading" class="muted-copy">{{ t('resourceQuery.empty') }}</p>
            <ol v-if="group.result?.releases.length" class="release-list">
              <li v-for="release in group.result.releases" :key="release.id" class="release-card">
                <div class="release-title-row">
                  <h3>{{ release.title }}</h3>
                  <a v-if="release.detailsUrl" class="release-detail-link" :href="release.detailsUrl" target="_blank" rel="noopener noreferrer"
                    :aria-label="t('resourceQuery.openDetails')" :title="t('resourceQuery.openDetails')">
                    <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14 5h5v5M19 5l-9 9M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
                  </a>
                </div>
                <p v-if="release.description" class="resource-query-description">{{ release.description }}</p>
                <dl class="release-facts">
                  <div v-if="release.sizeBytes !== undefined"><dt>{{ t('movie.releases.size') }}</dt><dd>{{ formatBytes(release.sizeBytes) }}</dd></div>
                  <div v-if="release.seeders !== undefined" class="release-fact-highlight" :class="{ healthy: release.seeders > 50, 'low-seeders': release.seeders < 20 }"><dt>{{ t('movie.releases.seeders') }}</dt><dd>{{ formatNumber(release.seeders) }}</dd></div>
                  <div v-if="release.resolution"><dt>{{ t('movie.releases.resolution') }}</dt><dd>{{ release.resolution }}</dd></div>
                  <div v-if="release.medium"><dt>{{ t('movie.releases.medium') }}</dt><dd>{{ release.medium }}</dd></div>
                  <div v-if="release.videoCodec"><dt>{{ t('movie.releases.videoCodec') }}</dt><dd>{{ release.videoCodec }}</dd></div>
                  <div v-if="release.audioCodec"><dt>{{ t('movie.releases.audioCodec') }}</dt><dd>{{ release.audioCodec }}</dd></div>
                  <div v-if="release.releaseGroup"><dt>{{ t('movie.releases.releaseGroup') }}</dt><dd>{{ release.releaseGroup }}</dd></div>
                  <div v-if="release.publishedAt"><dt>{{ t('movie.releases.publishedAt') }}</dt><dd>{{ release.publishedAt }}</dd></div>
                </dl>
                <div v-if="release.tags?.length" class="release-tags"><span v-for="tag in release.tags" :key="tag">{{ tag === 'chinese-subtitles' ? t('movie.releases.tags.chineseSubtitles') : tag }}</span></div>
              </li>
            </ol>
            <button v-if="group.result?.nextPage" class="text-button resource-query-more" type="button" :disabled="group.loading" @click="loadGroup(group, group.result.nextPage)">{{ t('resourceSelection.loadMore') }}</button>
          </div>
        </details>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.resource-query-dialog {
  width: min(880px, calc(100vw - 48px));
  max-height: min(760px, calc(100dvh - 48px));
  margin: auto;
  color: #e2e0d9;
}
.resource-query-dialog::backdrop { background: rgba(3, 4, 5, .78); backdrop-filter: blur(5px); }
.resource-query-description { margin: -2px 0 14px; color: #aeb3ba; font-size: .78rem; line-height: 1.6; overflow-wrap: anywhere; }
.resource-query-more { margin-top: 16px; }
@media (max-width: 700px) {
  .resource-query-dialog { width: calc(100vw - 24px); max-height: calc(100dvh - 24px); }
}
</style>
