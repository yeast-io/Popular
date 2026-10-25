<script setup lang="ts">
import type { ResourceDownloads } from './resource-download.types';
import { useI18n } from '../../i18n';
import { getIntegrationLogo } from '../settings/integration-logos';

const props = defineProps<{ controller: ResourceDownloads }>();
const { t } = useI18n();
const { confirmingRelease, downloadChoiceDialog, downloadProviders, selectedDownloaderId, downloadFor, confirmingSite,
  choiceFor, instanceLabel, remoteDevices, remoteAllowed, cancelDownload, submittingReleaseId, confirmDownload } = props.controller;
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    cancelDownload();
    return;
  }
  if (event.key !== 'Tab') return;
  event.stopPropagation();
  const focusable = [...(downloadChoiceDialog.value?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])') ?? [])];
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
</script>
<template>
          <div
            v-if="confirmingRelease"
            ref="downloadChoiceDialog"
            class="download-confirmation" @keydown="handleKeydown"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="download-confirm-title"
          >
            <div>
              <h3 id="download-confirm-title">{{ t('movie.download.confirmTitle') }}</h3>
              <fieldset class="download-provider-options" :aria-label="t('movie.download.provider')">
                <label v-for="choice in downloadProviders" :key="choice.downloaderInstanceId" class="download-provider-option">
                  <input
                    v-model="selectedDownloaderId"
                    type="radio"
                    name="download-provider"
                    :value="choice.downloaderInstanceId"
                    :disabled="
                      Boolean(
                        downloadFor(confirmingRelease.id, confirmingSite) && (downloadFor(confirmingRelease.id, confirmingSite)!.executionMode === 'remote' || choiceFor(downloadFor(confirmingRelease.id, confirmingSite)!)?.downloaderInstanceId !== choice.downloaderInstanceId),
                      )
                    "
                  />
                  <img :src="getIntegrationLogo(choice.provider)" alt="" class="download-provider-logo" aria-hidden="true" />
                  <span>{{ instanceLabel(choice) }}</span>
                </label>
                <hr v-if="downloadProviders.length && remoteDevices.length" class="download-provider-divider" />
                <label v-for="device in remoteDevices" :key="device.id" class="download-provider-option download-provider-option-agent" :title="t('movie.download.agentDeviceTooltip', { device: device.id })">
                  <input v-model="selectedDownloaderId" type="radio" name="download-provider" :value="`agent:${device.id}`" :disabled="!remoteAllowed(device.id)" />
                  <img src="/popular-link-agent-white-ui.png" alt="" class="download-provider-logo" aria-hidden="true" />
                  <span>
                    <b class="download-agent-name">
                      {{ t('movie.download.agentTarget') }}
                      <i
                        class="download-agent-status"
                        :class="{ 'is-online': device.isAgentOnline && device.isAgentDownloaderOnline }"
                        role="img"
                        :aria-label="t(device.isAgentOnline && device.isAgentDownloaderOnline ? 'remoteClient.online' : 'remoteClient.offline')"
                        :title="t(device.isAgentOnline && device.isAgentDownloaderOnline ? 'remoteClient.online' : 'remoteClient.offline')"
                      ></i>
                    </b>
                  </span>
                </label>
              </fieldset>
              <p v-if="selectedDownloaderId.startsWith('agent:')" class="download-retry-note" role="status">{{ t('movie.download.agentQueuePolicy') }}</p>
              <p v-if="downloadFor(confirmingRelease.id, confirmingSite)" class="download-retry-note">
                {{ t('movie.download.retryProvider') }}
              </p>
              <div class="download-confirm-actions">
                <button class="secondary" type="button" @click="cancelDownload">
                  {{ t('movie.download.cancel') }}
                </button>
                <button
                  class="primary"
                  type="button"
                  :disabled="!selectedDownloaderId || Boolean(submittingReleaseId)"
                  @click="confirmDownload"
                >
                  {{ t(selectedDownloaderId.startsWith('agent:') ? 'movie.download.pushAgent' : 'movie.download.confirm') }}
                </button>
              </div>
            </div>
          </div>
</template>
