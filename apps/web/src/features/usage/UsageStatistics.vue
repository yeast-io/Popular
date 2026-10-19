<script setup lang="ts">
import type { ExternalUsageDays, ExternalUsageResponse } from '@movie-hub/contract';
import { computed, onMounted, ref } from 'vue';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import { localizedErrorMessage } from '../../i18n/api-error';
import type { TokenUsage } from './usage-statistics.types.js';

const { apiBaseUrl } = loadWebConfig();
const { formatDate, formatNumber, t } = useI18n();
const ranges: ExternalUsageDays[] = [7, 30, 90];
const days = ref<ExternalUsageDays>(30);
const loading = ref(true);
const errorMessage = ref('');
const usage = ref<ExternalUsageResponse | null>(null);

const successRate = computed(() => {
  const totals = usage.value?.totals;
  return totals?.requests
    ? `${formatNumber((totals.successes / totals.requests) * 100, { maximumFractionDigits: 1 })}%`
    : '—';
});
const maxDailyRequests = computed(() => {
  return Math.max(
    1,
    ...(usage.value?.daily.map((day) => day.providers.reduce((sum, provider) => sum + provider.requests, 0)) ?? []),
  );
});

onMounted(loadUsage);

async function chooseRange(next: ExternalUsageDays) {
  if (days.value === next) return;
  days.value = next;
  await loadUsage();
}

async function loadUsage() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/external-usage?days=${days.value}`, { credentials: 'include' });
    if (!response.ok) throw new Error(`Usage request failed with status ${response.status}`);
    usage.value = (await response.json()) as ExternalUsageResponse;
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'usage.loadError');
  } finally {
    loading.value = false;
  }
}

function providerLabel(provider: string): string {
  if (provider === 'tmdb') return t('usage.provider.tmdb');
  if (provider === 'mteam') return t('usage.provider.mteam');
  if (provider === 'openai') return t('usage.provider.openai');
  return provider;
}

function operationLabel(operation: string): string {
  const known = {
    'movie.search': 'usage.operation.movieSearch',
    'movie.details': 'usage.operation.movieDetails',
    'movie.trending': 'usage.operation.movieTrending',
    'movie.discover': 'usage.operation.movieDiscover',
    'movie.recommendations': 'usage.operation.movieRecommendations',
    'release.search': 'usage.operation.releaseSearch',
    'connection.test': 'usage.operation.connectionTest',
    'torrent.download_token': 'usage.operation.downloadToken',
    'torrent.download': 'usage.operation.torrentDownload',
    'conversation.reply': 'usage.operation.conversationReply',
    'conversation.summary': 'usage.operation.conversationSummary',
    'assistant.intent': 'usage.operation.assistantIntent',
    'assistant.discuss': 'usage.operation.assistantDiscuss',
    'assistant.recommend': 'usage.operation.assistantRecommend',
    'preference.update': 'usage.operation.preferenceUpdate',
  } as const;
  const key = known[operation as keyof typeof known];
  return key ? t(key) : operation;
}

function providerColor(provider: string): string {
  let hash = 0;
  for (const character of provider) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 68% 56%)`;
}

function barHeight(requests: number): string {
  return `${Math.max(3, (requests / maxDailyRequests.value) * 100)}%`;
}

function showDateTick(index: number, total: number): boolean {
  if (total <= 7) return true;
  const interval = total <= 30 ? 5 : 15;
  return index === 0 || index === total - 1 || index % interval === 0;
}

function duration(milliseconds: number): string {
  return milliseconds < 1_000
    ? t('usage.durationMs', { value: formatNumber(milliseconds) })
    : t('usage.durationSeconds', { value: formatNumber(milliseconds / 1_000, { maximumFractionDigits: 1 }) });
}
function tokens(usage: TokenUsage | undefined, field: 'inputTokens' | 'outputTokens' | 'cachedInputTokens'): string {
  if (!usage) return '—';
  const unknown = field === 'cachedInputTokens' ? usage.unknownCachedRequests : usage.unknownRequests;
  const known =
    field === 'cachedInputTokens'
      ? usage.knownRequests + usage.unknownRequests - usage.unknownCachedRequests
      : usage.knownRequests;
  if (known === 0) return t('usage.unknown');
  return `${formatNumber(usage[field])}${unknown > 0 ? ' + ?' : ''}`;
}
</script>

<template>
  <section class="usage-page" aria-labelledby="usage-title">
    <div class="usage-heading">
      <div>
        <p class="eyebrow">{{ t('usage.eyebrow') }}</p>
        <h1 id="usage-title">{{ t('usage.title') }}</h1>
        <p>{{ t('usage.description') }}</p>
      </div>
      <div class="usage-range" role="group" :aria-label="t('usage.rangeLabel')">
        <button
          v-for="range in ranges"
          :key="range"
          type="button"
          :class="{ active: days === range }"
          :aria-pressed="days === range"
          :disabled="loading"
          @click="chooseRange(range)"
        >
          {{ t('usage.days', { days: range }) }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="loading usage-loading">{{ t('usage.loading') }}</div>
    <div v-else-if="errorMessage" class="usage-error" role="alert">
      <p>{{ errorMessage }}</p>
      <button class="outline-button" type="button" @click="loadUsage">{{ t('actions.retry') }}</button>
    </div>
    <div v-else-if="usage" class="usage-content">
      <section class="usage-summary" :aria-label="t('usage.summaryLabel')">
        <article>
          <span>{{ t('usage.totalRequests') }}</span
          ><strong>{{ formatNumber(usage.totals.requests) }}</strong>
        </article>
        <article>
          <span>{{ t('usage.successes') }}</span
          ><strong>{{ formatNumber(usage.totals.successes) }}</strong>
        </article>
        <article>
          <span>{{ t('usage.failures') }}</span
          ><strong>{{ formatNumber(usage.totals.failures) }}</strong>
        </article>
        <article>
          <span>{{ t('usage.successRate') }}</span
          ><strong>{{ successRate }}</strong>
        </article>
      </section>

      <div v-if="usage.totals.requests === 0" class="usage-empty">
        <span aria-hidden="true">∅</span>
        <h2>{{ t('usage.emptyTitle') }}</h2>
        <p>{{ t('usage.emptyDescription') }}</p>
      </div>

      <template v-else>
        <section class="usage-panel" aria-labelledby="usage-trend-title">
          <div class="usage-panel-heading">
            <div>
              <h2 id="usage-trend-title">{{ t('usage.dailyTrend') }}</h2>
              <p>{{ t('usage.dailyTrendDescription') }}</p>
            </div>
            <div class="usage-legend" aria-label="Providers">
              <span v-for="provider in usage.providers" :key="provider.provider">
                <i :style="{ background: providerColor(provider.provider) }" />{{ providerLabel(provider.provider) }}
              </span>
            </div>
          </div>
          <div class="usage-chart-scroll">
            <div class="usage-chart" :style="{ '--usage-days': usage.daily.length }">
              <div v-for="(day, index) in usage.daily" :key="day.date" class="usage-day">
                <div
                  class="usage-bar"
                  :aria-label="`${day.date}: ${day.providers.reduce((sum, provider) => sum + provider.requests, 0)}`"
                  :title="`${day.date}: ${day.providers.reduce((sum, provider) => sum + provider.requests, 0)}`"
                >
                  <span
                    v-for="provider in day.providers"
                    :key="provider.provider"
                    :style="{ height: barHeight(provider.requests), background: providerColor(provider.provider) }"
                    :title="`${providerLabel(provider.provider)}: ${provider.requests}`"
                  />
                </div>
                <time
                  v-if="showDateTick(index, usage.daily.length)"
                  :datetime="day.date"
                  :class="{ 'tick-start': index === 0, 'tick-end': index === usage.daily.length - 1 }"
                  >{{ formatDate(day.date, { month: 'short', day: 'numeric', timeZone: 'UTC' }) }}</time
                >
              </div>
            </div>
          </div>
        </section>

        <section class="usage-panel" aria-labelledby="usage-provider-title">
          <div class="usage-panel-heading">
            <div>
              <h2 id="usage-provider-title">{{ t('usage.providers') }}</h2>
              <p>{{ t('usage.providersDescription') }}</p>
            </div>
          </div>
          <div class="usage-provider-grid">
            <article
              v-for="provider in usage.providers"
              :key="provider.provider"
              :style="{ '--provider-color': providerColor(provider.provider) }"
            >
              <h3>{{ providerLabel(provider.provider) }}</h3>
              <strong>{{ formatNumber(provider.requests) }}</strong>
              <dl>
                <div>
                  <dt>{{ t('usage.failures') }}</dt>
                  <dd>{{ formatNumber(provider.failures) }}</dd>
                </div>
                <div>
                  <dt>{{ t('usage.averageDuration') }}</dt>
                  <dd>{{ duration(provider.averageDurationMs) }}</dd>
                </div>
                <template v-if="provider.tokenUsage">
                  <div>
                    <dt>{{ t('usage.inputTokens') }}</dt>
                    <dd>{{ tokens(provider.tokenUsage, 'inputTokens') }}</dd>
                  </div>
                  <div>
                    <dt>{{ t('usage.cachedInputTokens') }}</dt>
                    <dd>{{ tokens(provider.tokenUsage, 'cachedInputTokens') }}</dd>
                  </div>
                  <div>
                    <dt>{{ t('usage.outputTokens') }}</dt>
                    <dd>{{ tokens(provider.tokenUsage, 'outputTokens') }}</dd>
                  </div>
                </template>
              </dl>
              <p v-if="provider.tokenUsage?.unknownRequests" class="usage-note">
                {{ t('usage.unknownUsage', { count: provider.tokenUsage.unknownRequests }) }}
              </p>
              <p v-if="provider.tokenUsage?.unknownCachedRequests" class="usage-note">
                {{ t('usage.unknownCachedUsage', { count: provider.tokenUsage.unknownCachedRequests }) }}
              </p>
            </article>
          </div>
        </section>

        <section class="usage-panel" aria-labelledby="usage-operation-title">
          <div class="usage-panel-heading">
            <div>
              <h2 id="usage-operation-title">{{ t('usage.operations') }}</h2>
              <p>{{ t('usage.operationsDescription') }}</p>
            </div>
          </div>
          <div class="usage-table-scroll">
            <table class="usage-table">
              <thead>
                <tr>
                  <th>{{ t('usage.service') }}</th>
                  <th>{{ t('usage.operation') }}</th>
                  <th>{{ t('usage.calls') }}</th>
                  <th>{{ t('usage.failures') }}</th>
                  <th>{{ t('usage.averageDuration') }}</th>
                  <th>{{ t('usage.inputTokens') }}</th>
                  <th>{{ t('usage.cachedInputTokens') }}</th>
                  <th>{{ t('usage.outputTokens') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="operation in usage.operations" :key="`${operation.provider}:${operation.operation}`">
                  <td>
                    <span class="usage-provider-dot" :style="{ background: providerColor(operation.provider) }" />{{
                      providerLabel(operation.provider)
                    }}
                  </td>
                  <td>{{ operationLabel(operation.operation) }}</td>
                  <td>{{ formatNumber(operation.requests) }}</td>
                  <td>{{ formatNumber(operation.failures) }}</td>
                  <td>{{ duration(operation.averageDurationMs) }}</td>
                  <td>{{ tokens(operation.tokenUsage, 'inputTokens') }}</td>
                  <td>{{ tokens(operation.tokenUsage, 'cachedInputTokens') }}</td>
                  <td>{{ tokens(operation.tokenUsage, 'outputTokens') }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section v-if="usage.models?.length" class="usage-panel" aria-labelledby="usage-model-title">
          <div class="usage-panel-heading">
            <div>
              <h2 id="usage-model-title">{{ t('usage.models') }}</h2>
              <p>{{ t('usage.tokenNote') }}</p>
            </div>
          </div>
          <div class="usage-table-scroll">
            <table class="usage-table">
              <thead>
                <tr>
                  <th>{{ t('usage.model') }}</th>
                  <th>{{ t('usage.operation') }}</th>
                  <th>{{ t('usage.calls') }}</th>
                  <th>{{ t('usage.failures') }}</th>
                  <th>{{ t('usage.averageDuration') }}</th>
                  <th>{{ t('usage.inputTokens') }}</th>
                  <th>{{ t('usage.cachedInputTokens') }}</th>
                  <th>{{ t('usage.outputTokens') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="model in usage.models" :key="`${model.provider}:${model.model}:${model.operation}`">
                  <td>{{ model.model }}</td>
                  <td>{{ operationLabel(model.operation) }}</td>
                  <td>{{ formatNumber(model.requests) }}</td>
                  <td>{{ formatNumber(model.failures) }}</td>
                  <td>{{ duration(model.averageDurationMs) }}</td>
                  <td>{{ tokens(model.tokenUsage, 'inputTokens') }}</td>
                  <td>{{ tokens(model.tokenUsage, 'cachedInputTokens') }}</td>
                  <td>{{ tokens(model.tokenUsage, 'outputTokens') }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>

      <p class="usage-note">
        {{ t('usage.retentionNote', { days: usage.range.retentionDays }) }} · {{ t('usage.countingNote') }} ·
        {{ t('usage.timezoneNote') }}
      </p>
    </div>
  </section>
</template>
