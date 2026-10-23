<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import type { RemoteClientConfiguration, RemoteClientMutationResult, RemoteClientKey, ApiError } from '@movie-hub/contract';
import type { RemoteClientAction, RemoteClientConfirmation } from './remote-client.types';
import { loadWebConfig } from '../../config/env';
import { formatDate, t, useI18n } from '../../i18n';
import { LocalizedApiError, localizedApiError, localizedErrorMessage } from '../../i18n/api-error';

const { apiBaseUrl } = loadWebConfig();
const { locale } = useI18n();
const configuration = ref<RemoteClientConfiguration>({ hasKey: false, canReadKey: false, authVersion: 0, deviceLimit: 1, devices: [], gatewayNotificationPending: false });
const loading = ref(true);
const loaded = ref(false);
const busy = ref(false);
const confirmation = ref<RemoteClientConfirmation | null>(null);
const apiKey = ref('');
const showKey = ref(false);
const errorMessage = ref('');
const saved = ref(false);
const copied = ref(false);
const expanded = ref(false);
let poll: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void refresh();
  poll = setInterval(() => {
    if (!busy.value && !loading.value) void refresh(true);
  }, 60_000);
});
onBeforeUnmount(() => clearInterval(poll));

function applyConfiguration(next: RemoteClientConfiguration) {
  if (configuration.value.authVersion !== next.authVersion || !next.hasKey) {
    apiKey.value = '';
    showKey.value = false;
    copied.value = false;
  }
  configuration.value = next;
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}/me/remote-client${path}`, {
    credentials: 'include', cache: 'no-store', ...init,
    headers: { 'accept-language': locale.value, ...(init?.body ? { 'content-type': 'application/json' } : {}) },
  });
  if (!response.ok) {
    const body = await response.json() as ApiError;
    if (response.status === 409) throw new LocalizedApiError('remoteClient.conflict');
    throw localizedApiError(body, 'errors.requestFailed');
  }
  return response.json() as Promise<T>;
}
async function refresh(silent = false) {
  if (!silent) loading.value = true;
  errorMessage.value = '';
  try {
    applyConfiguration(await request<RemoteClientConfiguration>(''));
    loaded.value = true;
  } catch (error) {
    configuration.value = { ...configuration.value, devices: configuration.value.devices.map((device) => ({
      ...device, isAgentOnline: false, isAgentDownloaderOnline: false,
    })) };
    errorMessage.value = localizedErrorMessage(error, 'remoteClient.failed');
  } finally {
    loading.value = false;
  }
}
async function loadKey(): Promise<string> {
  if (!apiKey.value) {
    const result = await request<RemoteClientKey>('/key');
    if (result.authVersion !== configuration.value.authVersion) {
      await refresh();
      if (result.authVersion !== configuration.value.authVersion || !configuration.value.canReadKey) throw new LocalizedApiError('remoteClient.conflict');
    }
    apiKey.value = result.apiKey;
  }
  return apiKey.value;
}
async function revealKey() {
  if (busy.value) return;
  if (showKey.value) {
    showKey.value = false;
    return;
  }
  busy.value = true;
  errorMessage.value = '';
  try {
    await loadKey();
    showKey.value = true;
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'remoteClient.failed');
  } finally {
    busy.value = false;
  }
}
async function copyKey() {
  if (busy.value) return;
  busy.value = true;
  copied.value = false;
  errorMessage.value = '';
  try {
    const key = await loadKey();
    try {
      await navigator.clipboard.writeText(key);
      copied.value = true;
    } catch {
      showKey.value = true;
      errorMessage.value = t('remoteClient.copyFailed');
    }
  } catch (error) { errorMessage.value = localizedErrorMessage(error, 'remoteClient.failed'); } finally {
    busy.value = false;
  }
}
async function change(action: RemoteClientAction) {
  if (busy.value || !loaded.value) return;
  busy.value = true;
  errorMessage.value = '';
  copied.value = false;
  saved.value = false;
  apiKey.value = '';
  showKey.value = false;
  try {
    const result = await request<RemoteClientMutationResult>(`/${action}`, {
      method: 'POST', body: JSON.stringify({ operationId: crypto.randomUUID(), expectedAuthVersion: configuration.value.authVersion }),
    });
    applyConfiguration(result.configuration);
    apiKey.value = result.apiKey ?? '';
    showKey.value = Boolean(apiKey.value);
    expanded.value = true;
    saved.value = true;
    confirmation.value = null;
  } catch (error) { errorMessage.value = localizedErrorMessage(error, 'remoteClient.failed'); } finally {
    busy.value = false;
  }
}
async function confirmChange() {
  const action = confirmation.value;
  if (!action || busy.value) return;
  if (action.kind !== 'unbind') {
    await change(action.kind);
    return;
  }
  busy.value = true;
  errorMessage.value = '';
  saved.value = false;
  copied.value = false;
  try {
    applyConfiguration(await request<RemoteClientConfiguration>(`/devices/${encodeURIComponent(action.device.id)}/unbind`, {
      method: 'POST', body: JSON.stringify({ operationId: crypto.randomUUID(), expectedAuthVersion: action.device.authVersion, expectedDeviceVersion: action.device.deviceVersion }),
    }));
    saved.value = true;
    confirmation.value = null;
  } catch (error) { errorMessage.value = localizedErrorMessage(error, 'remoteClient.failed'); } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section id="remote-client" class="settings-card integration-card remote-client-card" :class="{ 'is-expanded': expanded }" aria-labelledby="remote-client-title" :aria-busy="loading || busy">
    <div class="connection-card-heading">
      <span class="connection-badge remote-client-badge" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3a6 6 0 0 0-5.4 8.6L3 18.2V21h3v-3h3v-3l2.4-2.4A6 6 0 1 0 15 3ZM17 7h.01" /></svg>
      </span>
      <div class="connection-copy">
        <div class="integration-title-row">
          <h3 id="remote-client-title">{{ t('remoteClient.title') }}</h3>
          <span v-if="loaded && !loading" class="integration-status" :class="configuration.hasKey ? 'configured_valid' : 'unconfigured'">{{ configuration.hasKey ? t('remoteClient.keyActive') : t('remoteClient.noKey') }}</span>
        </div>
        <p>{{ t('remoteClient.description') }}</p>
      </div>
      <button class="integration-disclosure" type="button" :disabled="busy || loading" :aria-expanded="expanded" aria-controls="remote-client-body" @click="expanded = !expanded">
        {{ expanded ? t('settings.collapse') : t('remoteClient.manage') }}
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg>
      </button>
    </div>
    <p v-if="errorMessage && !expanded" class="error settings-message connection-card-notice" role="alert">{{ errorMessage }}</p>
    <div v-show="expanded" id="remote-client-body" class="connection-card-body">
      <p v-if="loading" class="loading compact-loading" role="status">{{ t('remoteClient.loading') }}</p>
      <template v-else-if="loaded">
        <div v-if="configuration.hasKey && configuration.canReadKey" class="remote-key integration-form">
          <div class="settings-fields">
            <div class="remote-key-control">
              <label for="remote-client-api-key">{{ t('remoteClient.key') }}</label>
              <div class="remote-key-input">
                <input id="remote-client-api-key" :type="showKey ? 'text' : 'password'" :value="apiKey || '••••••••••••••••'" readonly autocomplete="off" spellcheck="false" @focus="($event.target as HTMLInputElement).select()" />
                <div class="remote-key-input-actions">
                  <button data-action="show-key" type="button" :aria-label="showKey ? t('remoteClient.hideKey') : t('remoteClient.showKey')" :title="showKey ? t('remoteClient.hideKey') : t('remoteClient.showKey')" :disabled="busy" @click="revealKey">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" /><path v-if="!showKey" d="M3 3l18 18" /></svg>
                  </button>
                  <button data-action="copy-key" type="button" :aria-label="t('remoteClient.copyKey')" :title="t('remoteClient.copyKey')" :disabled="busy" @click="copyKey">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <p v-else-if="configuration.hasKey" class="connection-note">{{ t('remoteClient.existingKey') }}</p>
        <div class="remote-client-devices">
          <h4>{{ t('remoteClient.devices', { count: configuration.devices.length, limit: configuration.deviceLimit }) }}</h4>
          <p v-if="!configuration.devices.length" class="connection-note">{{ t('remoteClient.noDevice') }}</p>
          <div v-for="device in configuration.devices" :key="device.id" class="remote-client-device">
            <dl class="integration-summary">
              <div><dt>{{ t('remoteClient.device') }}</dt><dd>{{ device.id }}</dd></div>
              <div><dt>{{ t('remoteClient.agentStatus') }}</dt><dd>{{ t(device.isAgentOnline ? 'remoteClient.online' : 'remoteClient.offline') }}</dd></div>
              <div><dt>{{ t('remoteClient.downloaderStatus') }}</dt><dd>{{ t(device.isAgentOnline && device.isAgentDownloaderOnline ? 'remoteClient.online' : 'remoteClient.offline') }}</dd></div>
              <div><dt>{{ t('remoteClient.boundAt') }}</dt><dd>{{ formatDate(device.boundAt, { dateStyle: 'medium', timeStyle: 'short' }) }}</dd></div>
            </dl>
            <button data-action="unbind" :data-device-id="device.id" type="button" class="secondary danger" :disabled="busy" @click="confirmation = { kind: 'unbind', device }">{{ t('remoteClient.unbind') }}</button>
          </div>
        </div>
        <p v-if="configuration.gatewayNotificationPending" class="connection-note" role="status">{{ t('remoteClient.pending') }}</p>
      </template>
      <p v-if="confirmation" class="connection-note remote-client-confirmation" role="status">
        {{ confirmation.kind === 'unbind' ? t('remoteClient.unbindConfirm', { device: confirmation.device.id }) : confirmation.kind === 'revoke' ? t('remoteClient.revokeConfirm') : t('remoteClient.regenerateConfirm') }}
      </p>
      <div class="settings-card-footer integration-form-footer">
        <div class="settings-feedback integration-feedback">
          <p v-if="errorMessage" role="alert" class="error settings-message">{{ errorMessage }}</p>
          <p v-else-if="copied" role="status" class="success settings-message">{{ t('remoteClient.copied') }}</p>
          <p v-else-if="saved && !configuration.gatewayNotificationPending" role="status" class="success settings-message">{{ t('remoteClient.changed') }}</p>
        </div>
        <div class="integration-actions">
          <button type="button" class="secondary" :disabled="busy || loading" @click="refresh()">{{ t('remoteClient.refresh') }}</button>
          <template v-if="loaded && !loading">
            <template v-if="confirmation">
              <button type="button" class="secondary" :disabled="busy" @click="confirmation = null">{{ t('remoteClient.cancel') }}</button>
              <button data-action="confirm" type="button" class="secondary danger" :disabled="busy" @click="confirmChange">{{ busy ? t('remoteClient.busy') : t('remoteClient.confirm') }}</button>
            </template>
            <template v-else>
              <button v-if="!configuration.hasKey" data-action="generate" type="button" class="primary" :disabled="busy" @click="change('generate')">{{ t('remoteClient.generate') }}</button>
              <template v-else>
                <button data-action="regenerate" type="button" class="secondary danger" :disabled="busy" @click="confirmation = { kind: 'regenerate' }">{{ t('remoteClient.regenerate') }}</button>
                <button data-action="revoke" type="button" class="secondary danger" :disabled="busy" @click="confirmation = { kind: 'revoke' }">{{ t('remoteClient.revoke') }}</button>
              </template>
            </template>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.remote-client-badge svg { width: 24px; height: 24px; }
.remote-key { min-width: 0; }
.remote-key-control { min-width: 0; }
.remote-key-control label { display: block; margin-bottom: 9px; }
.remote-key-input { position: relative; min-width: 0; }
.remote-key-input input { width: 100%; padding-right: 96px; font-family: monospace; }
.remote-key-input-actions { position: absolute; top: 50%; right: 6px; display: flex; gap: 2px; transform: translateY(-50%); }
.remote-key-input-actions button { display: grid; width: 38px; height: 38px; place-items: center; padding: 0; border: 0; border-radius: 6px; color: #a6a9a4; background: transparent; cursor: pointer; }
.remote-key-input-actions button:hover:not(:disabled) { color: #f1f0ed; background: rgba(255, 255, 255, 0.08); }
.remote-key-input-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
.remote-key-input-actions button:focus-visible { outline: 2px solid #e84b2c; outline-offset: -2px; }
.remote-key-input-actions svg { width: 19px; height: 19px; }
.remote-client-devices { margin-top: 22px; }
.remote-client-devices h4 { margin: 0 0 14px; color: #c4c1ba; font-size: 0.8rem; font-weight: 600; }
.remote-client-device { display: flex; align-items: center; gap: 16px; padding: 14px 0; border-bottom: 1px solid #ffffff12; }
.remote-client-device .integration-summary { flex: 1; margin: 0; padding: 0; border: 0; }
.remote-client-confirmation { margin-top: 16px; margin-bottom: 0; }
@media (max-width: 640px) {
  .remote-client-device { flex-wrap: wrap; }
  .remote-client-device .integration-summary { flex-basis: 100%; }
  .remote-client-device button { margin-left: auto; }
}
</style>
