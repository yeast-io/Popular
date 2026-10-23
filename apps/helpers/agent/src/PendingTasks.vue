<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import messages from './locales/messages.json';
import { queueDate, queueRemaining } from './queue.presentation';
import type { QueuePageProps, QueueView } from './queue.types';

const props = defineProps<QueuePageProps>();
const text = computed(() => messages[props.locale]);
const view = ref<QueueView>({ snapshot: null, stale: true, loading: true });
const error = ref(false);
const changing = ref(false);
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval>;
let reading = false;
async function refresh() {
  if (reading) return;
  reading = true;
  now.value = Date.now();
  try {
    view.value = await invoke<QueueView>('queue_status');
    error.value = false;
  } catch {
    error.value = true;
  } finally {
    reading = false;
  }
}
async function page(cursor: string | null) {
  changing.value = true;
  try {
    await invoke('queue_page', { cursor });
    await refresh();
  } catch {
    error.value = true;
  } finally {
    changing.value = false;
  }
}
onMounted(() => {
  void refresh();
  timer = setInterval(() => void refresh(), 2000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <section class="pending-tasks" :aria-label="text.queueTitle" :aria-busy="view.loading || changing">
    <div class="queue-heading">
      <div>
        <h2>{{ view.snapshot ? text.queueCount.replace('{count}', String(view.snapshot.total)) : text.queueTitle }}</h2>
        <p v-if="view.snapshot" class="queue-sync">{{ text.queueLastSync }} · {{ queueDate(view.snapshot.observedAt, locale) }}</p>
      </div>
      <button type="button" class="quiet" :disabled="changing" @click="page(view.snapshot?.cursor ?? null)">{{ text.queueRefresh }}</button>
    </div>
    <p v-if="error" class="error" role="alert">{{ text.queueLoadError }}</p>
    <p v-if="view.snapshot && view.stale" class="queue-cache-note" role="status">{{ text.queueStale }}</p>
    <p v-else-if="view.snapshot" class="queue-live">{{ text.queueLive }}</p>
    <p v-if="!view.snapshot" class="queue-empty" role="status">{{ text.queueNotSynced }}</p>
    <p v-else-if="!view.snapshot.total" class="queue-empty" role="status">{{ text.queueEmpty }}</p>
    <p v-if="view.loading && view.snapshot" class="queue-sync" role="status">{{ text.queueLoading }}</p>
    <ol v-if="view.snapshot?.items.length" class="queue-list">
      <li v-for="item in view.snapshot.items" :key="item.commandId" class="queue-card">
        <div class="queue-card-heading">
          <span class="queue-site">{{ item.source === 'mteam' ? 'M-Team' : 'HDArea' }}</span>
          <span class="queue-reason">{{ text[`queueReason_${item.reason}`] }}</span>
        </div>
        <h3>{{ item.title || text.queueResource.replace('{id}', item.resourceId) }}</h3>
        <dl>
          <div><dt>{{ text.queueEnqueued }}</dt><dd>{{ queueDate(item.enqueuedAt, locale) }}</dd></div>
          <div><dt>{{ text.queueExpires }}</dt><dd>{{ queueDate(item.expiresAt, locale) }}</dd></div>
          <div class="queue-remaining" :class="{ urgent: item.expiresAt - now < 3600000 }"><dt>{{ text.queueRemaining }}</dt><dd>{{ queueRemaining(item.expiresAt, now, locale) }}</dd></div>
        </dl>
      </li>
    </ol>
    <footer v-if="view.snapshot && (view.snapshot.cursor || view.snapshot.nextCursor)" class="queue-pagination">
      <button type="button" :disabled="!view.snapshot.cursor || view.loading || changing" @click="page(null)">{{ text.queueFirst }}</button>
      <button type="button" :disabled="!view.snapshot.nextCursor || view.loading || changing" @click="page(view.snapshot.nextCursor)">{{ text.queueNext }}</button>
    </footer>
  </section>
</template>
