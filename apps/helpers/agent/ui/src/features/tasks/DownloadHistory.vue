<script setup lang="ts">
import { computed } from 'vue';
import { useAgentClient } from '../../transport/agent-client.composable';
import messages from '../../locales/messages.json';
import type { QueuePageProps } from './queue.types';
import { useDownloadHistory } from './download-history.composable';

const props = defineProps<QueuePageProps>();
const t = computed(() => messages[props.locale]);
const { available, items, loading, error, limit, refresh } = useDownloadHistory(useAgentClient());
function label(value: string | null) {
  return (t.value as Record<string, string>)[`historyStatus_${value}`] ?? t.value.statusUnknown;
}
</script>
<template>
  <section v-if="available" class="settings-panel" :aria-label="t.downloadHistory" :aria-busy="loading">
    <div class="panel-heading">
      <h2>{{ t.downloadHistory }}</h2>
      <button type="button" class="quiet" :disabled="loading" @click="refresh">{{ t.queueRefresh }}</button>
    </div>
    <p>{{ t.downloadHistoryDescription }}</p>
    <p v-if="loading" role="status">{{ t.queueLoading }}</p>
    <p v-if="error" class="error" role="alert">{{ t.historyLoadError }}</p>
    <p v-else-if="!loading && !items.length">{{ t.historyEmpty }}</p>
    <ol class="queue-list">
      <li v-for="item in items.slice(0, limit)" :key="item.executionId" class="queue-card">
        <div class="queue-card-heading">
          <strong>{{ item.provider === 'qbittorrent' ? t.qbittorrentName : t.transmissionName }}</strong>
          <span>{{ label(item.phase) }}</span>
        </div>
        <dl>
          <div>
            <dt>{{ t.historyDownloadId }}</dt>
            <dd>
              <code>{{ item.downloadId }}</code>
            </dd>
          </div>
          <div>
            <dt>{{ t.historyExecutionId }}</dt>
            <dd>
              <code>{{ item.executionId }}</code>
            </dd>
          </div>
          <div>
            <dt>{{ t.historyLastState }}</dt>
            <dd>{{ label(item.state) }}</dd>
          </div>
          <div v-if="item.progress !== null">
            <dt>{{ t.historyProgress }}</dt>
            <dd>
              {{ new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(item.progress) }}
            </dd>
          </div>
        </dl>
      </li>
    </ol>
    <button v-if="items.length > limit" type="button" @click="limit += 20">{{ t.historyMore }}</button>
  </section>
</template>
