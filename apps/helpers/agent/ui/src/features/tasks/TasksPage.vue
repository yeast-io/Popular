<script setup lang="ts">
import { computed } from 'vue';
import { useAgentClient } from '../../transport/agent-client.composable';
import messages from '../../locales/messages.json';
import { queueCount, queueDate, queueRemaining, queueSiteName } from './queue.presentation';
import { useTaskQueue } from './task-queue.composable';
import type { QueuePageProps } from './queue.types';

const props = defineProps<QueuePageProps>();
const text = computed(() => messages[props.locale]);
const { view, error, changing, now, page } = useTaskQueue(useAgentClient());
</script>
<template>
  <section class="pending-tasks" :aria-label="text.queueTitle" :aria-busy="view.loading || changing">
    <div class="queue-heading">
      <div>
        <h2>{{ view.snapshot ? queueCount(view.snapshot.total, locale) : text.queueTitle }}</h2>
        <p v-if="view.snapshot" class="queue-sync">
          {{ text.queueLastSync }} · {{ queueDate(view.snapshot.observedAt, locale) }}
        </p>
      </div>
      <button
        type="button"
        class="quiet"
        :disabled="changing || view.loading"
        @click="page(view.snapshot?.cursor ?? null)"
      >
        {{ text.queueRefresh }}
      </button>
    </div>
    <p v-if="error" class="error" role="alert">{{ text.queueLoadError }}</p>
    <p v-if="view.snapshot && view.stale" class="queue-cache-note" role="status">{{ text.queueStale }}</p>
    <p v-else-if="view.snapshot" class="queue-live">{{ text.queueLive }}</p>
    <div v-if="!view.snapshot" class="queue-empty" role="status">
      <strong>{{ text.noSnapshotTitle }}</strong>
      <p>{{ text.queueNotSynced }}</p>
    </div>
    <div v-else-if="!view.snapshot.total" class="queue-empty" role="status">
      <strong>{{ text.emptyQueueTitle }}</strong>
      <p>{{ text.queueEmpty }}</p>
    </div>
    <p v-if="view.loading && view.snapshot" class="queue-sync" role="status">{{ text.queueLoading }}</p>
    <ol v-if="view.snapshot?.items.length" class="queue-list">
      <li v-for="item in view.snapshot.items" :key="item.commandId" class="queue-card">
        <div class="queue-card-heading">
          <span class="queue-site">{{ queueSiteName(item.source) }}</span>
          <span class="queue-reason">{{ text[`queueReason_${item.reason}`] }}</span>
        </div>
        <h3>{{ item.title || text.queueResource.replace('{id}', item.resourceId) }}</h3>
        <p v-if="item.reason === 'torrent_daily_limit'" class="queue-limit" role="status">
          {{ text.queueLimitExplanation.replace('{site}', queueSiteName(item.source)) }}
          {{ item.nextAttemptAt && item.nextAttemptAt > now ? text.queueLimitPaused : text.queueLimitDue }}
        </p>
        <dl>
          <div>
            <dt>{{ text.queueEnqueued }}</dt>
            <dd>{{ queueDate(item.enqueuedAt, locale) }}</dd>
          </div>
          <div>
            <dt>{{ text.queueExpires }}</dt>
            <dd>{{ queueDate(item.expiresAt, locale) }}</dd>
          </div>
          <div v-if="item.reason === 'torrent_daily_limit' && item.limitDetectedAt">
            <dt>{{ text.queueLimitDetected }}</dt>
            <dd>{{ queueDate(item.limitDetectedAt, locale) }}</dd>
          </div>
          <div v-if="item.lastAttemptAt">
            <dt>{{ text.queueLastAttempt }}</dt>
            <dd>{{ queueDate(item.lastAttemptAt, locale) }}</dd>
          </div>
          <div v-if="item.nextAttemptAt">
            <dt>{{ text.queueNextAttempt }}</dt>
            <dd>
              {{
                item.nextAttemptAt < item.expiresAt
                  ? queueDate(item.nextAttemptAt, locale)
                  : text.queueExpiresBeforeRetry
              }}
            </dd>
          </div>
          <div class="queue-remaining" :class="{ urgent: item.expiresAt - now < 3600000 }">
            <dt>{{ text.queueRemaining }}</dt>
            <dd>{{ queueRemaining(item.expiresAt, now, locale) }}</dd>
          </div>
        </dl>
      </li>
    </ol>
    <footer v-if="view.snapshot && (view.snapshot.cursor || view.snapshot.nextCursor)" class="queue-pagination">
      <button type="button" :disabled="!view.snapshot.cursor || view.loading || changing" @click="page(null)">
        {{ text.queueFirst }}
      </button>
      <button
        type="button"
        :disabled="!view.snapshot.nextCursor || view.loading || changing"
        @click="page(view.snapshot.nextCursor)"
      >
        {{ text.queueNext }}
      </button>
    </footer>
  </section>
</template>
