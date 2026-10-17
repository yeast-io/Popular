<script setup lang="ts">
import IntegrationCard from '../settings/IntegrationCard.vue';
import type { OpenAIConfiguration } from '@movie-hub/contract';
import { computed, onMounted, ref } from 'vue';
import { loadWebConfig } from '../../config/env';
import { formatDate, t } from '../../i18n';
import { localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';

const { apiBaseUrl } = loadWebConfig();
const config = ref<OpenAIConfiguration>({ configured: false });
const apiKey = ref('');
const loading = ref(true);
const busy = ref(false);
const testing = ref(false);
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
      <p v-if="config.validation" class="openai-test-detail">{{ t('openai.checkedAt', { date: formatDate(config.validation.checkedAt, { dateStyle: 'medium', timeStyle: 'short' }), model: config.validation.model }) }}</p>
      <p v-else-if="config.model" class="openai-test-detail">{{ t('openai.testModel', { model: config.model }) }}</p>
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
</style>
