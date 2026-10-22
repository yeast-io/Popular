<script setup lang="ts">
import type { ApiError, QBittorrentConfiguration, TransmissionConfiguration } from '@movie-hub/contract';
import { nextTick, onMounted, ref } from 'vue';
import { loadWebConfig } from '../../config/env';
import { t } from '../../i18n';
import { localizedApiError, localizedErrorMessage } from '../../i18n/api-error';
import { getIntegrationLogo } from '../settings/integration-logos';
import QBittorrentSettings from './QBittorrentSettings.vue';
import TransmissionSettings from './TransmissionSettings.vue';

const { apiBaseUrl } = loadWebConfig();
const qbittorrent = ref<QBittorrentConfiguration[]>([]);
const transmission = ref<TransmissionConfiguration[]>([]);
const creating = ref<'qbittorrent' | 'transmission' | null>(null);
const addOpen = ref(false);
const loading = ref(true);
const errorMessage = ref('');
const firstOption = ref<HTMLButtonElement | null>(null);
const dialog = ref<HTMLElement | null>(null);
let returnFocus: HTMLElement | null = null;

async function openAddDialog() {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  creating.value = null;
  addOpen.value = true;
  await nextTick();
  firstOption.value?.focus();
}

function closeAddDialog() {
  if (!addOpen.value) return;
  addOpen.value = false;
  creating.value = null;
  nextTick(() => returnFocus?.focus());
}

function handleDialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeAddDialog();
    return;
  }
  if (event.key !== 'Tab' || !dialog.value) return;
  const focusable = Array.from(dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)'));
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

defineExpose({ openAddDialog });

onMounted(() => {
  void loadInstances();
});

async function fetchInstances<T>(provider: string): Promise<T[]> {
  const response = await fetch(`${apiBaseUrl}/me/integrations/${provider}/instances`, { credentials: 'include' });
  const data: unknown = await response.json();
  if (!response.ok) throw localizedApiError(data as ApiError, 'errors.requestFailed');
  return data as T[];
}

async function loadInstances() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const [qb, tr] = await Promise.all([
      fetchInstances<QBittorrentConfiguration>('qbittorrent'),
      fetchInstances<TransmissionConfiguration>('transmission'),
    ]);
    qbittorrent.value = qb;
    transmission.value = tr;
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.serviceUnavailable');
  } finally {
    loading.value = false;
  }
}

function instanceChanged() {
  closeAddDialog();
  void loadInstances();
}
</script>

<template>
  <p v-if="errorMessage" class="error settings-message" role="alert">{{ errorMessage }}</p>
  <p v-if="loading" class="loading compact-loading">{{ t('downloader.loading') }}</p>
  <template v-else>
    <QBittorrentSettings v-for="(instance, index) in qbittorrent" :key="instance.downloaderInstanceId ?? `qb-${index}`" :instance="instance" @changed="instanceChanged" />
    <TransmissionSettings v-for="(instance, index) in transmission" :key="instance.downloaderInstanceId ?? `tr-${index}`" :instance="instance" @changed="instanceChanged" />
  </template>
  <div v-if="addOpen" class="downloader-add-overlay" @click.self="closeAddDialog">
    <section ref="dialog" class="downloader-add-dialog" role="dialog" aria-modal="true" aria-labelledby="downloader-add-title" @keydown="handleDialogKeydown">
      <header class="downloader-add-header">
        <h3 id="downloader-add-title">{{ t('downloader.add') }}</h3>
        <button class="downloader-add-close" type="button" :aria-label="t('downloader.close')" @click="closeAddDialog">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>
      <div class="downloader-type-picker">
        <span class="downloader-type-picker-label">{{ t('downloader.chooseType') }}</span>
        <div class="downloader-type-options">
          <button ref="firstOption" type="button" class="downloader-type-option" :class="{ 'is-selected': creating === 'qbittorrent' }"
            :aria-pressed="creating === 'qbittorrent'" @click="creating = 'qbittorrent'">
            <img :src="getIntegrationLogo('qbittorrent')" alt="" width="32" height="32" />
            <span>qBittorrent</span>
          </button>
          <button type="button" class="downloader-type-option" :class="{ 'is-selected': creating === 'transmission' }"
            :aria-pressed="creating === 'transmission'" @click="creating = 'transmission'">
            <img :src="getIntegrationLogo('transmission')" alt="" width="32" height="32" />
            <span>Transmission</span>
          </button>
        </div>
      </div>
      <div v-if="creating" class="downloader-add-form">
        <QBittorrentSettings v-if="creating === 'qbittorrent'" creating embedded @changed="instanceChanged" />
        <TransmissionSettings v-else creating embedded @changed="instanceChanged" />
      </div>
    </section>
  </div>
</template>
