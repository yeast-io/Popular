<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { TelegramBinding, TelegramConfiguration } from '@movie-hub/contract';
import IntegrationCard from '../settings/IntegrationCard.vue';
import { loadWebConfig } from '../../config/env';
import { t, formatDate } from '../../i18n';
import { localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';

const emit = defineEmits<{ bindingChange: [] }>();
const { apiBaseUrl } = loadWebConfig();
const state = ref<TelegramConfiguration>({ status: 'unbound' });
const bindingUrl = ref('');
const loading = ref(true);
const busy = ref(false);
const confirmRemove = ref(false);
const error = ref('');
const success = ref('');
let disposed = false;
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const controllers = new Set<AbortController>();
const label = computed(() => t(`telegram.${state.value.status}`));
function setState(next: TelegramConfiguration) {
  if (!next || !['unavailable', 'unbound', 'pending', 'connected'].includes(next.status))
    throw new Error(t('errors.requestFailed'));
  const changed = state.value.status !== next.status;
  state.value = next;
  if (next.status !== 'pending') bindingUrl.value = '';
  if (changed) emit('bindingChange');
}
async function request(method = 'GET', suffix = '') {
  const controller = new AbortController();
  controllers.add(controller);
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/telegram${suffix}`, {
      method,
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw await localizedResponseError(response);
    return response.status === 204 ? null : await response.json();
  } finally {
    controllers.delete(controller);
  }
}
async function refresh() {
  const current = generation;
  try {
    const result = await request();
    if (!disposed && current === generation) {
      setState(result);
      error.value = '';
    }
  } catch (cause) {
    if (!disposed && current === generation) {
      bindingUrl.value = '';
      error.value = localizedErrorMessage(cause, 'errors.requestFailed');
    }
  } finally {
    if (!disposed) loading.value = false;
  }
}
function schedule() {
  if (disposed) return;
  timer = setTimeout(async () => {
    if (!busy.value && state.value.status === 'pending') await refresh();
    schedule();
  }, 3_000);
}
async function act(action: 'bind' | 'test' | 'remove') {
  if (busy.value || loading.value) return;
  busy.value = true;
  generation++;
  controllers.forEach((controller) => controller.abort());
  error.value = '';
  success.value = '';
  if (action !== 'test') bindingUrl.value = '';
  try {
    const result = await request(action === 'remove' ? 'DELETE' : 'POST', action === 'remove' ? '' : `/${action}`);
    if (disposed) return;
    if (action === 'test') success.value = t('telegram.testSent');
    else {
      setState(result ?? { status: 'unbound' });
      if (action === 'bind') {
        const url = new URL((result as TelegramBinding).bindingUrl);
        if (url.origin !== 'https://t.me' || url.username || url.password) throw new Error(t('errors.requestFailed'));
        bindingUrl.value = url.href;
      }
    }
    confirmRemove.value = false;
  } catch (cause) {
    if (!disposed) error.value = localizedErrorMessage(cause, 'errors.requestFailed');
  } finally {
    if (!disposed) busy.value = false;
  }
}
onMounted(async () => {
  await refresh();
  schedule();
});
onUnmounted(() => {
  disposed = true;
  if (timer) clearTimeout(timer);
  controllers.forEach((controller) => controller.abort());
  bindingUrl.value = '';
});
</script>
<template>
  <IntegrationCard
    id="telegram"
    title="Telegram"
    badge="TG"
    :description="t('telegram.description')"
    :status-label="label"
    :status-class="state.status === 'connected' ? 'configured_valid' : 'unconfigured'"
    :configured="state.status === 'connected'"
    :loading="loading"
    :busy="busy"
    :notice="error"
    :force-open="state.status === 'pending'"
    :action-label="state.status === 'unbound' ? t('settings.bind') : undefined"
    @open="state.status === 'unbound' && act('bind')"
  >
    <template #actions>
      <slot v-if="state.status === 'connected'" name="notifications" :disabled="loading || busy" />
    </template>
    <div class="integration-form">
      <p v-if="state.status === 'unavailable'">{{ t('telegram.unavailableHint') }}</p>
      <template v-else>
        <p>{{ t('telegram.hint') }}</p>
        <p v-if="state.account">{{ t('telegram.account') }}: {{ state.account }}</p>
        <template v-if="state.status === 'pending'">
          <p>{{ t('telegram.startHint') }}</p>
          <p v-if="state.expiresAt">
            {{ t('telegram.expires', { time: formatDate(state.expiresAt, { timeStyle: 'short' }) }) }}
          </p>
          <a
            v-if="bindingUrl"
            class="primary telegram-link"
            :href="bindingUrl"
            target="_blank"
            rel="noopener noreferrer"
            referrerpolicy="no-referrer"
            >{{ t('telegram.open') }}</a
          >
        </template>
      </template>
      <div class="settings-card-footer integration-form-footer">
        <div class="settings-feedback integration-feedback">
          <p v-if="error" class="error settings-message" role="alert">{{ error }}</p>
          <p v-if="success" class="success settings-message" role="status">{{ success }}</p>
        </div>
        <div v-if="state.status !== 'unavailable'" class="integration-actions">
          <template v-if="confirmRemove">
            <span>{{ t('telegram.removeConfirm') }}</span>
            <button class="secondary" type="button" :disabled="busy" @click="confirmRemove = false">
              {{ t('qbittorrent.cancel') }}
            </button>
            <button class="secondary danger" type="button" :disabled="busy" @click="act('remove')">
              {{ t('telegram.confirmRemove') }}
            </button>
          </template>
          <template v-else>
            <button
              v-if="state.status !== 'unbound'"
              class="secondary danger"
              type="button"
              :disabled="busy || loading"
              @click="confirmRemove = true"
            >
              {{ t('telegram.remove') }}
            </button>
            <button
              v-if="state.status === 'connected'"
              class="primary"
              type="button"
              :disabled="busy || loading"
              @click="act('test')"
            >
              {{ t('telegram.test') }}
            </button>
            <button v-else class="primary" type="button" :disabled="busy || loading" @click="act('bind')">
              {{ t(state.status === 'pending' ? 'telegram.regenerate' : 'telegram.bind') }}
            </button>
          </template>
        </div>
      </div>
    </div>
  </IntegrationCard>
</template>
<style scoped>
.telegram-link {
  display: inline-flex;
  justify-content: center;
  padding: 0.7rem 1rem;
  border-radius: 0.5rem;
  text-decoration: none;
  background: #258ac2;
  color: white;
  width: fit-content;
}
</style>
