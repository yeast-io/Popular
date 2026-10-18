<script setup lang="ts">
import IntegrationCard from '../settings/IntegrationCard.vue';
import type { OpenAIConfiguration } from '@movie-hub/contract';
import { computed, onMounted, ref, watch } from 'vue';
import { loadWebConfig } from '../../config/env';
import { formatDate, t } from '../../i18n';
import { localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';

const { apiBaseUrl } = loadWebConfig();
const config = ref<OpenAIConfiguration>({ configured: false });
const apiKey = ref('');
const loading = ref(true);
const busy = ref(false);
const testing = ref(false);
const selectedModel = ref('');
const models = computed(() => config.value.validation?.models ?? []);
watch(config, value => {
  const model = value.model ?? '';
  selectedModel.value = models.value.includes(model) ? model : '';
});
const statusLabel = computed(() => !config.value.configured ? t('openai.unconfigured')
  : config.value.validation?.status === 'valid' ? t('openai.valid')
  : config.value.validation?.status === 'failed' ? t('openai.failed') : t('openai.configured'));
const statusClass = computed(() => !config.value.configured ? 'unconfigured'
  : config.value.validation?.status === 'valid' ? 'configured_valid'
  : config.value.validation?.status === 'failed' ? 'configured_invalid' : 'configured_unverified');
const validationNotice = computed(() => config.value.validation?.status === 'failed'
  ? t(`openai.failure.${config.value.validation.failureReason ?? 'request_failed'}`) : '');
const confirmDelete = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
onMounted(async () => {
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/openai`, { credentials: 'include' });
    if (!response.ok) throw await localizedResponseError(response);
    config.value = await response.json();
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.requestFailed');
  } finally { loading.value = false; }
});

async function save() {
  if (busy.value || !apiKey.value.trim()) return;
  busy.value = true; errorMessage.value = ''; successMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/openai`, {
      method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: apiKey.value.trim() }),
    });
    if (!response.ok) throw await localizedResponseError(response);
    config.value = await response.json();
    apiKey.value = '';
    successMessage.value = t('openai.saved');
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.requestFailed');
  } finally { busy.value = false; }
}

async function testConnection() {
  if (busy.value || !config.value.configured || apiKey.value.trim()) return;
  busy.value = true; testing.value = true; errorMessage.value = ''; successMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/openai/test`, { method: 'POST', credentials: 'include' });
    if (!response.ok) throw await localizedResponseError(response);
    config.value = await response.json();
    if (config.value.validation?.status === 'valid') successMessage.value = t('openai.testPassed');
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.requestFailed');
  } finally { busy.value = false; testing.value = false; }
}

async function saveModel() {
  if (busy.value || apiKey.value.trim() || !selectedModel.value) return;
  busy.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/openai/model`, {
      method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: selectedModel.value }),
    });
    if (!response.ok) throw await localizedResponseError(response);
    config.value = await response.json();
    successMessage.value = t('openai.modelSaved');
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.requestFailed');
  } finally { busy.value = false; }
}

async function remove() {
  busy.value = true; errorMessage.value = ''; successMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/openai`, { method: 'DELETE', credentials: 'include' });
    if (!response.ok) throw await localizedResponseError(response);
    config.value = { configured: false }; apiKey.value = ''; confirmDelete.value = false;
    successMessage.value = t('openai.deleted');
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.requestFailed');
  } finally { busy.value = false; }
}
</script>

<template>
  <IntegrationCard id="openai" title="OpenAI" badge="AI" :description="t('settings.aiSummary')"
    :status-label="statusLabel" :status-class="statusClass" :configured="config.configured" :busy="busy" :loading="loading" :notice="errorMessage || validationNotice">
    <p v-if="loading" class="loading compact-loading">{{ t('openai.loading') }}</p>
    <form v-else class="integration-form" @submit.prevent="save">
      <div class="settings-fields integration-fields">
        <label for="openai-api-key">
          OpenAI API Key <span v-if="config.configured">({{ config.maskedApiKey }})</span>
          <input id="openai-api-key" v-model="apiKey" type="password" autocomplete="new-password" minlength="20" maxlength="4096" :disabled="busy" :placeholder="config.configured ? t('openai.replaceHint') : 'sk-…'" />
          <small>{{ t('openai.keyHint') }}</small>
        </label>
      </div>
      <p class="connection-note openai-test-hint">{{ t('openai.testHint') }}</p>
      <p v-if="apiKey.trim() && config.configured" class="openai-test-detail">{{ t('openai.saveFirst') }}</p>
      <p v-if="config.validation" class="openai-test-detail">{{ t('openai.checkedAt', { date: formatDate(config.validation.checkedAt, { dateStyle: 'medium', timeStyle: 'short' }) }) }}</p>
      <p v-if="config.model" class="openai-test-detail">{{ t('openai.currentModel', { model: config.model }) }}</p>
      <div v-if="config.validation?.status === 'valid'" class="settings-fields integration-fields openai-model-fields">
        <label for="openai-model">
          {{ t('openai.model') }}
          <span class="openai-model-select">
          <select id="openai-model" v-model="selectedModel" :disabled="busy || Boolean(apiKey.trim()) || !models.length">
            <option disabled value="">{{ t('openai.chooseModel') }}</option>
            <option v-for="model in models" :key="model" :value="model">{{ model }}</option>
          </select>
          <svg class="openai-model-chevron" viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
            <path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          </span>
          <small>{{ t('openai.modelHint') }}</small>
          <small v-if="!models.length">{{ t('openai.noModels') }}</small>
        </label>
        <button class="secondary openai-model-save" type="button" :disabled="busy || Boolean(apiKey.trim()) || !selectedModel || selectedModel === config.model" @click="saveModel">{{ t('openai.saveModel') }}</button>
      </div>
      <div class="settings-card-footer integration-form-footer">
        <div class="settings-feedback integration-feedback">
          <p v-if="errorMessage" class="error settings-message" role="alert">{{ errorMessage }}</p>
          <p v-if="validationNotice && !errorMessage" class="error settings-message" role="alert">{{ validationNotice }}</p>
          <p v-if="successMessage" class="success settings-message" role="status">{{ successMessage }}</p>
        </div>
        <div class="integration-actions">
          <template v-if="config.configured && confirmDelete">
            <span>{{ t('openai.deleteConfirm') }}</span>
            <button class="secondary" type="button" :disabled="busy" @click="confirmDelete = false">{{ t('qbittorrent.cancel') }}</button>
            <button class="secondary danger" type="button" :disabled="busy" @click="remove">{{ t('qbittorrent.confirmDelete') }}</button>
          </template>
          <button v-else-if="config.configured" class="secondary danger" type="button" :disabled="busy" @click="confirmDelete = true">{{ t('openai.delete') }}</button>
          <button v-if="config.configured && !confirmDelete" class="secondary openai-test-button" type="button" :disabled="busy || Boolean(apiKey.trim())" @click="testConnection">{{ testing ? t('openai.testing') : t('openai.test') }}</button>
          <button class="primary" type="submit" :disabled="busy || apiKey.trim().length < 20">{{ busy && !testing ? t('openai.saving') : t('openai.save') }}</button>
        </div>
      </div>
    </form>
  </IntegrationCard>
</template>

<style scoped>
.openai-test-detail { margin: 0; color: #93988e; font-size: .73rem; line-height: 1.6; overflow-wrap: anywhere; }
.openai-test-hint { margin: 0; }
.openai-test-button { white-space: nowrap; }
.openai-model-fields { grid-template-columns: minmax(0, 1fr); justify-items: start; }
.openai-model-fields label { width: 100%; min-width: 0; }
.openai-model-select { position: relative; display: block; width: min(100%, 360px); }
.openai-model-chevron {
  position: absolute; right: 14px; top: 50%; transform: translateY(-50%);
  pointer-events: none; color: #b8bcb3;
}
#openai-model {
  appearance: none; -webkit-appearance: none; box-sizing: border-box;
  width: 100%; min-width: 0; min-height: 42px; padding: 10px 42px 10px 14px;
  border: 1px solid #292a2b; border-radius: 7px; background: #111314;
  color: inherit; font: inherit; text-overflow: ellipsis; color-scheme: dark;
}
#openai-model:disabled { opacity: .55; cursor: not-allowed; }
</style>
