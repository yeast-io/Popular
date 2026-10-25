<script setup lang="ts">
import type { ResourceSiteRelease } from '@movie-hub/contract';
import type { ResourceDownloads } from './resource-download.types';
import { useI18n } from '../../i18n';

const props = defineProps<{ controller: ResourceDownloads; release: ResourceSiteRelease; site: string; supportsDownload: boolean }>();
const { t, formatDate } = useI18n();
const { canDownload, downloadUnavailable, downloadFor, downloadActionLabel, requestDownload, submittingReleaseId,
  downloadKey, providerName, downloadStatus, downloadErrors } = props.controller;
</script>
<template>
                <div class="release-download-actions">
                  <span v-if="!canDownload(release.id, site)" class="muted-copy">{{ downloadUnavailable(release.id, site) }}</span>
                  <button
                    v-if="supportsDownload && (!downloadFor(release.id, site) || ['failed', 'missing'].includes(downloadFor(release.id, site)!.status))"
                    class="release-download-button"
                    type="button"
                    :disabled="!canDownload(release.id, site) || Boolean(submittingReleaseId)"
                    :aria-label="downloadActionLabel(release.id, site)"
                    :title="canDownload(release.id, site) ? downloadActionLabel(release.id, site) : downloadUnavailable(release.id, site)"
                    @click="requestDownload(release, site)"
                  >
                    <svg aria-hidden="true" viewBox="0 0 24 24">
                      <path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14" />
                    </svg>
                  </button>
                </div>
                <div
                  v-if="submittingReleaseId === downloadKey(release.id, site)"
                  class="release-download-progress downloading"
                  role="status"
                >
                  <div>
                    <span>{{ t('movie.download.submitting') }}</span>
                  </div>
                  <progress :aria-label="t('movie.download.submitting')"></progress>
                </div>
                <div
                  v-else-if="downloadFor(release.id, site)"
                  class="release-download-progress"
                  :class="{
                    missing: downloadFor(release.id, site)!.status === 'missing',
                    downloading: downloadFor(release.id, site)!.status === 'downloading',
                    seeding: ['completed', 'seeding'].includes(downloadFor(release.id, site)!.status),
                  }"
                  role="status"
                >
                  <div>
                    <span
                      >{{ downloadFor(release.id, site)!.downloaderName || providerName(downloadFor(release.id, site)!.provider) }} ·
                      {{ downloadStatus(downloadFor(release.id, site)!) }}</span
                    >
                    <strong v-if="downloadFor(release.id, site)!.status !== 'missing'">{{ Math.round(downloadFor(release.id, site)!.progress) }}%</strong>
                  </div>
                  <progress
                    v-if="downloadFor(release.id, site)!.status !== 'missing'"
                    :value="downloadFor(release.id, site)!.progress"
                    max="100"
                    :aria-label="
                      t('movie.download.progress', { progress: Math.round(downloadFor(release.id, site)!.progress) })
                    "
                  ></progress>
                </div>
                <p v-if="downloadFor(release.id, site)?.executionMode === 'remote' && downloadFor(release.id, site)?.queueExpiresAt && !['succeeded', 'duplicate'].includes(downloadFor(release.id, site)?.pushState ?? '')" class="download-retry-note" role="status">
                  {{ t('movie.download.agentExpires', { date: formatDate(downloadFor(release.id, site)!.queueExpiresAt!, { dateStyle: 'short', timeStyle: 'short' }) }) }}
                </p>
                <p v-if="downloadErrors[downloadKey(release.id, site)]" class="browse-error" role="alert">
                  {{ downloadErrors[downloadKey(release.id, site)] }}
                </p>
</template>
