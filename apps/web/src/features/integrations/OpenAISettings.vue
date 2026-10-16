<script setup lang="ts">
import type { OpenAIConfiguration } from '@movie-hub/contract';
import { onMounted, ref } from 'vue';
import { loadWebConfig } from '../../config/env';
import { t } from '../../i18n';
import { localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';

const { apiBaseUrl } = loadWebConfig();
const config = ref<OpenAIConfiguration>({ configured: false });
const apiKey = ref('');
const loading = ref(true);
const busy = ref(false);
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
  <section class="settings-card integration-card" aria-labelledby="openai-section-title" :aria-busy="loading || busy">
    <div class="settings-card-heading compact integration-heading">
      <div>
        <div class="integration-title-row">
          <h2 id="openai-section-title">OpenAI</h2>
          <span class="integration-status" :class="config.configured ? 'configured_unverified' : 'unconfigured'">
            {{ config.configured ? t('openai.configured') : t('openai.unconfigured') }}
          </span>
        </div>
        <p>{{ t('openai.description') }}</p>
      </div>
    </div>
    <p v-if="loading" class="loading compact-loading">{{ t('openai.loading') }}</p>
    <form v-else class="integration-form" @submit.prevent="save">
      <div class="settings-fields integration-fields">
        <label for="openai-api-key">
          OpenAI API Key <span v-if="config.configured">({{ config.maskedApiKey }})</span>
          <input id="openai-api-key" v-model="apiKey" type="password" autocomplete="new-password" minlength="20" maxlength="4096" :disabled="busy" :placeholder="config.configured ? t('openai.replaceHint') : 'sk-…'" />
          <small>{{ t('openai.keyHint') }}</small>
        </label>
      </div>
      <div class="settings-card-footer integration-form-footer">
        <div class="settings-feedback integration-feedback">
          <p v-if="errorMessage" class="error settings-message" role="alert">{{ errorMessage }}</p>
          <p v-if="successMessage" class="success settings-message" role="status">{{ successMessage }}</p>
        </div>
        <div class="integration-actions">
          <template v-if="config.configured && confirmDelete">
            <span>{{ t('openai.deleteConfirm') }}</span>
            <button class="secondary" type="button" :disabled="busy" @click="confirmDelete = false">{{ t('qbittorrent.cancel') }}</button>
            <button class="secondary danger" type="button" :disabled="busy" @click="remove">{{ t('qbittorrent.confirmDelete') }}</button>
          </template>
          <button v-else-if="config.configured" class="secondary danger" type="button" :disabled="busy" @click="confirmDelete = true">{{ t('openai.delete') }}</button>
          <button class="primary" type="submit" :disabled="busy || apiKey.trim().length < 20">{{ busy ? t('openai.saving') : t('openai.save') }}</button>
        </div>
      </div>
    </form>
  </section>
</template>
