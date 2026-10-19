<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import type { NotificationTestList, NotificationTestResult } from '@movie-hub/contract';
import { loadWebConfig } from '../../config/env';
import { t } from '../../i18n';
import { localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';
const { apiBaseUrl } = loadWebConfig();
const channels = ref<NotificationTestList['channels']>([]);
const items = ref<NotificationTestList['items']>([]);
const page = ref(1);
const hasMore = ref(false);
const loading = ref(false);
const sending = ref('');
const error = ref('');
const feedback = ref<Record<string, NotificationTestResult['results']>>({});
const cooldowns = ref<Record<string, number>>({});
let disposed = false;
let timer: ReturnType<typeof setInterval> | undefined;
const controller = new AbortController();
async function load(nextPage = 1) {
  if (loading.value || sending.value) return;
  loading.value = true;
  error.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/notification-tests/downloads?page=${nextPage}`, {
      credentials: 'include',
      signal: controller.signal,
    });
    if (!response.ok) throw await localizedResponseError(response);
    const data = (await response.json()) as NotificationTestList;
    if (!disposed) {
      items.value = data.items;
      channels.value = data.channels;
      page.value = data.page;
      hasMore.value = data.hasMore;
    }
  } catch (cause) {
    if (!disposed) error.value = localizedErrorMessage(cause, 'errors.requestFailed');
  } finally {
    if (!disposed) loading.value = false;
  }
}
async function send(id: string, channel: string) {
  if (sending.value || cooldowns.value[channel]) return;
  sending.value = `${id}:${channel}`;
  error.value = '';
  feedback.value[id] = (feedback.value[id] ?? []).filter((result) => result.channel !== channel);
  try {
    const response = await fetch(`${apiBaseUrl}/me/notification-tests/downloads/${id}/send`, {
      method: 'POST',
      credentials: 'include',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel }),
    });
    if (!response.ok) throw await localizedResponseError(response);
    const data = (await response.json()) as NotificationTestResult;
    if (!disposed) {
      feedback.value[id] = [...(feedback.value[id] ?? []), ...data.results];
      cooldowns.value[channel] = 30;
      if (!timer)
        timer = setInterval(() => {
          for (const channel of Object.keys(cooldowns.value))
            if (cooldowns.value[channel]! > 0) cooldowns.value[channel] = cooldowns.value[channel]! - 1;
          if (Object.values(cooldowns.value).every((seconds) => seconds === 0) && timer) {
            clearInterval(timer);
            timer = undefined;
          }
        }, 1000);
    }
  } catch (cause) {
    if (!disposed) error.value = localizedErrorMessage(cause, 'errors.requestFailed');
  } finally {
    if (!disposed) sending.value = '';
  }
}
onMounted(() => {
  void load();
});
onUnmounted(() => {
  disposed = true;
  controller.abort();
  if (timer) clearInterval(timer);
});
</script>
<template>
  <section class="notification-test-page settings-page">
    <div class="test-heading">
      <div>
        <span class="test-badge">DEV / TEST</span>
        <h1>{{ t('notificationTest.title') }}</h1>
      </div>
      <button type="button" class="secondary" :disabled="loading || Boolean(sending)" @click="load(page)">
        {{ t('notificationTest.refresh') }}
      </button>
    </div>
    <p class="test-description">{{ t('notificationTest.description') }}</p>
    <p class="connection-note">{{ t('notificationTest.hint') }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="loading" role="status">{{ t('notificationTest.loading') }}</p>
    <p v-else-if="!items.length">{{ t('notificationTest.empty') }}</p>
    <div v-else class="test-downloads">
      <article v-for="item in items" :key="item.id" class="settings-card test-download">
        <img v-if="item.posterUrl" :src="item.posterUrl" :alt="item.title" loading="lazy" width="70" height="105" />
        <div v-else class="test-poster-placeholder" aria-hidden="true">▶</div>
        <div class="test-download-info">
          <h2>{{ item.title }}</h2>
          <p class="test-resource-name" :title="item.resourceName">{{ item.resourceName }}</p>
          <small>{{ item.provider }} · {{ (item.totalBytes / 1024 ** 3).toFixed(2) }} GiB</small>
          <div v-if="feedback[item.id]" role="status">
            <p
              v-for="result in feedback[item.id]"
              :key="result.channel"
              class="test-result"
              :class="result.sent ? 'success' : 'error'"
            >
              {{ result.channel }} · {{ t(result.sent ? 'notificationTest.accepted' : 'notificationTest.failed') }}
            </p>
          </div>
        </div>
        <div class="test-send-actions">
          <button
            v-for="channel in channels"
            :key="channel.id"
            type="button"
            class="primary"
            :data-channel="channel.id"
            :disabled="!channel.configured || Boolean(sending) || (cooldowns[channel.id] ?? 0) > 0"
            @click="send(item.id, channel.id)"
          >
            {{
              !channel.configured
                ? t('notificationTest.channelUnlinked', { channel: channel.name })
                : sending === `${item.id}:${channel.id}`
                  ? t('notificationTest.sending')
                  : cooldowns[channel.id]
                    ? t('notificationTest.channelCooldown', { channel: channel.name, seconds: cooldowns[channel.id]! })
                    : t('notificationTest.sendChannel', { channel: channel.name })
            }}
          </button>
        </div>
      </article>
    </div>
    <nav class="test-pagination" :aria-label="t('notificationTest.pagination')">
      <button
        class="secondary"
        type="button"
        :disabled="page <= 1 || loading || Boolean(sending)"
        @click="load(page - 1)"
      >
        {{ t('notificationTest.previous') }}
      </button>
      <span>{{ page }}</span
      ><button
        class="secondary"
        type="button"
        :disabled="!hasMore || loading || Boolean(sending)"
        @click="load(page + 1)"
      >
        {{ t('notificationTest.next') }}
      </button>
    </nav>
  </section>
</template>
<style scoped>
.notification-test-page {
  width: min(100%, 1120px);
  min-width: 0;
  margin: 2rem auto;
  padding: 0 1rem;
}
.notification-test-page button {
  width: auto;
  min-width: 0;
  margin: 0;
  padding: 0.7rem 1rem;
  border-radius: 7px;
  font-size: 0.8rem;
  font-weight: 600;
  line-height: 1.4;
}
.notification-test-page button:disabled {
  cursor: not-allowed;
}
.test-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
}
.test-heading > div {
  min-width: 0;
}
.test-heading button {
  flex: 0 0 auto;
}
.test-heading h1 {
  margin: 0.6rem 0;
  font-family: inherit;
  font-size: clamp(1.5rem, 4vw, 2rem);
  font-weight: 600;
  letter-spacing: -0.035em;
}
.test-badge {
  display: inline-flex;
  color: #dcb67b;
  background: #aa783614;
  border: 1px solid #aa783638;
  border-radius: 4px;
  padding: 0.25rem 0.5rem;
  font-size: 0.6rem;
  font-weight: 600;
  letter-spacing: 0.12em;
}
.test-description {
  margin: 0.35rem 0 0.7rem;
  color: #c2c2bc;
  font-size: 0.9rem;
}
.notification-test-page > .connection-note {
  max-width: 78ch;
  margin: 0;
  color: #838680;
  font-size: 0.75rem;
  line-height: 1.7;
}
.test-downloads {
  display: grid;
  min-width: 0;
  gap: 0.75rem;
  margin-top: 1.5rem;
}
.test-download {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) auto;
  align-items: center;
  gap: 1.25rem;
  min-width: 0;
  padding: 1rem 1.25rem;
  border: 1px solid #ffffff12;
  border-radius: 10px;
  background: linear-gradient(120deg, #1c1d1ee0, #141516ed);
}
.test-download img,
.test-poster-placeholder {
  display: block;
  width: 64px;
  height: 96px;
  object-fit: cover;
  border-radius: 5px;
}
.test-poster-placeholder {
  display: grid;
  place-items: center;
  background: #27282a;
  color: #666;
}
.test-download-info {
  min-width: 0;
}
.test-download h2 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: inherit;
  font-size: 0.95rem;
  font-weight: 600;
  margin: 0 0 0.5rem;
}
.test-resource-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin: 0 0 0.6rem;
  color: #858982;
  font-size: 0.75rem;
  line-height: 1.5;
}
.test-download small {
  display: block;
  color: #a5a89f;
  font-size: 0.7rem;
}
.test-send-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
  max-width: 24rem;
}
.test-send-actions button {
  white-space: normal;
}
.test-result {
  margin: 0.6rem 0 0;
  font-size: 0.75rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.test-result.success {
  color: #95c6a2;
}
.test-result.error {
  color: #e39a8e;
}
.test-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  margin: 1.5rem 0;
  color: #92978e;
  font-size: 0.8rem;
}
@media (max-width: 640px) {
  .notification-test-page {
    padding: 0 0.25rem;
    margin-top: 1.25rem;
  }
  .test-heading {
    gap: 0.75rem;
  }
  .test-heading button {
    padding: 0.6rem 0.7rem;
  }
  .test-download {
    grid-template-columns: 52px minmax(0, 1fr);
    gap: 0.75rem 1rem;
    padding: 1rem;
  }
  .test-download img,
  .test-poster-placeholder {
    width: 52px;
    height: 78px;
  }
  .test-send-actions {
    grid-column: 2;
    justify-content: flex-start;
    max-width: 100%;
  }
}
</style>
