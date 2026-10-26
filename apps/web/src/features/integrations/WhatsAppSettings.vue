<script setup lang="ts">
import IntegrationCard from '../settings/IntegrationCard.vue';
import type { WhatsAppConfiguration } from '@movie-hub/contract';
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { loadWebConfig } from '../../config/env';
import { t } from '../../i18n';
import { localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';

const emit = defineEmits<{ bindingChange: [] }>();
const { apiBaseUrl } = loadWebConfig();
const state = ref<WhatsAppConfiguration>({ status: 'unbound' });
watch(
  () => state.value.status,
  () => emit('bindingChange')
);
const loading = ref(true);
const busy = ref(false);
const confirmRemove = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
let disposed = false;
let version = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
const statusLabels = {
  unbound: 'whatsapp.unbound',
  connecting: 'whatsapp.connecting',
  qr: 'whatsapp.qr',
  pairing: 'whatsapp.pairing',
  connected: 'whatsapp.connected',
  disconnected: 'whatsapp.disconnected',
  error: 'whatsapp.error',
} as const;

async function request(method = 'GET', suffix = '') {
  controller = new AbortController();
  const response = await fetch(`${apiBaseUrl}/me/integrations/whatsapp${suffix}`, {
    method,
    credentials: 'include',
    cache: 'no-store',
    signal: controller.signal,
  });
  if (!response.ok) throw await localizedResponseError(response);
  return response.status === 204 ? null : await response.json();
}
async function refresh() {
  const current = version;
  try {
    const result = await request();
    if (!disposed && current === version) {
      state.value = result;
      errorMessage.value = '';
    }
  } catch (error) {
    if (!disposed && current === version) {
      // Never leave a stale login QR visible after a failed status request.
      state.value = { status: 'error' };
      errorMessage.value = localizedErrorMessage(error, 'errors.requestFailed');
    }
  } finally {
    if (!disposed) loading.value = false;
  }
}
function schedule() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (disposed || busy.value || !['connecting', 'qr', 'pairing'].includes(state.value.status)) return;
  timer = setTimeout(async () => {
    timer = undefined;
    if (!busy.value) await refresh();
    schedule();
  }, 3_000);
}
async function act(action: 'bind' | 'test' | 'remove') {
  if (busy.value) return;
  busy.value = true;
  if (timer) clearTimeout(timer);
  timer = undefined;
  version++;
  controller?.abort();
  errorMessage.value = '';
  successMessage.value = '';
  try {
    const result = await request(action === 'remove' ? 'DELETE' : 'POST', action === 'remove' ? '' : `/${action}`);
    if (disposed) return;
    if (action === 'test') successMessage.value = t('whatsapp.testSent');
    else state.value = result ?? { status: 'unbound' };
    confirmRemove.value = false;
  } catch (error) {
    if (!disposed) errorMessage.value = localizedErrorMessage(error, 'errors.requestFailed');
  } finally {
    if (!disposed) {
      busy.value = false;
      schedule();
    }
  }
}
onMounted(async () => {
  await refresh();
  schedule();
});
onUnmounted(() => {
  disposed = true;
  if (timer) clearTimeout(timer);
  controller?.abort();
  state.value = { status: 'unbound' };
});
</script>

<template>
  <IntegrationCard
    id="whatsapp"
    title="WhatsApp"
    badge="WA"
    :description="t('settings.whatsappSummary')"
    :status-label="t(statusLabels[state.status])"
    :status-class="state.status === 'connected' ? 'configured_valid' : 'unconfigured'"
    :configured="state.status === 'connected'"
    :busy="busy"
    :force-open="state.status === 'qr' || state.status === 'connecting' || state.status === 'pairing'"
    :action-label="state.status === 'unbound' ? t('settings.bind') : undefined"
    @open="state.status === 'unbound' && act('bind')"
    :loading="loading"
    :notice="errorMessage"
  >
    <template #actions>
      <slot v-if="state.status === 'connected'" name="notifications" :disabled="loading || busy" />
    </template>
    <p v-if="loading" class="loading compact-loading">{{ t('whatsapp.loading') }}</p>
    <div v-else class="integration-form">
      <p class="connection-note">{{ t('whatsapp.limitations') }}</p>
      <p v-if="state.failureReason" class="error settings-message" role="alert">
        {{ t(`whatsapp.failure.${state.failureReason}`) }}
        <span v-if="state.disconnectCode !== undefined">{{
          t('whatsapp.disconnectCode', { code: state.disconnectCode })
        }}</span>
      </p>
      <p v-if="state.status === 'pairing'" role="status">{{ t('whatsapp.pairingHint') }}</p>
      <p v-if="state.account">{{ t('whatsapp.account') }}: {{ state.account }}</p>
      <div v-if="state.status === 'qr' && state.qrDataUrl" class="whatsapp-pairing">
        <p>{{ t('whatsapp.scan') }}</p>
        <img :src="state.qrDataUrl" :alt="t('whatsapp.qrAlt')" width="280" height="280" />
        <small>{{ t('whatsapp.qrHint') }}</small>
      </div>
      <p v-if="state.status === 'connecting'">{{ t('whatsapp.wait') }}</p>
      <p v-if="state.status === 'connected'">{{ t('whatsapp.testHint') }}</p>
      <p v-if="state.status === 'disconnected' || state.status === 'error'">{{ t('whatsapp.reconnectHint') }}</p>
      <div class="settings-card-footer integration-form-footer" :class="{ 'whatsapp-remove-confirmation': confirmRemove }">
        <div v-if="errorMessage || successMessage || !confirmRemove" class="settings-feedback integration-feedback">
          <p v-if="errorMessage" class="error settings-message" role="alert">{{ errorMessage }}</p>
          <p v-if="successMessage" class="success settings-message" role="status">{{ successMessage }}</p>
        </div>
        <p v-if="confirmRemove" class="whatsapp-remove-message">{{ t('whatsapp.removeConfirm') }}</p>
        <div class="integration-actions">
          <template v-if="confirmRemove">
            <button class="secondary" type="button" :disabled="busy" @click="confirmRemove = false">
              {{ t('qbittorrent.cancel') }}
            </button>
            <button class="secondary danger" type="button" :disabled="busy" @click="act('remove')">
              {{ t('whatsapp.confirmRemove') }}
            </button>
          </template>
          <template v-else>
            <button
              v-if="state.status !== 'unbound'"
              class="secondary danger"
              type="button"
              :disabled="busy"
              @click="confirmRemove = true"
            >
              {{ t('whatsapp.remove') }}
            </button>
            <button
              v-if="state.status === 'connected'"
              class="primary"
              type="button"
              :disabled="busy"
              @click="act('test')"
            >
              {{ t('whatsapp.test') }}
            </button>
            <button
              v-else
              class="primary"
              type="button"
              :disabled="busy || state.status === 'connecting' || state.status === 'qr' || state.status === 'pairing'"
              @click="act('bind')"
            >
              {{ t('whatsapp.bind') }}
            </button>
          </template>
        </div>
      </div>
    </div>
  </IntegrationCard>
</template>

<style scoped>
.whatsapp-remove-confirmation {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
}
.whatsapp-remove-message {
  margin: 0;
  overflow-wrap: anywhere;
}
.whatsapp-remove-confirmation .integration-actions {
  min-width: 0;
  max-width: 100%;
}
.whatsapp-pairing {
  display: grid;
  justify-items: start;
  gap: 0.75rem;
}
.whatsapp-pairing img {
  max-width: 100%;
  height: auto;
  background: white;
  border-radius: 0.5rem;
}
</style>
