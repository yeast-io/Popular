<script setup lang="ts">
import IntegrationCard from '../settings/IntegrationCard.vue';
import type { AiConfiguration, AiProvider } from '@movie-hub/contract';
import { computed, onMounted, ref, watch } from 'vue';
import { loadWebConfig } from '../../config/env';
import { formatDate, t, useI18n } from '../../i18n';
import { localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';

const props = withDefaults(defineProps<{ provider?: AiProvider }>(), { provider: 'openai' });
const { locale } = useI18n();
const { apiBaseUrl } = loadWebConfig();
const config = ref<AiConfiguration>({ configured: false });
const apiKey = ref('');
const loading = ref(true);
const busy = ref(false);
const testing = ref(false);
const verified = computed(() => config.value.configured && config.value.validation?.status === 'valid' && !apiKey.value.trim());
const canVerify = computed(() => !busy.value && !confirmDelete.value && (apiKey.value.trim() ? apiKey.value.trim().length >= 20 : config.value.configured));
const selectedModel = ref('');
const models = computed(() => config.value.validation?.models ?? []);
watch(config, (value) => {
  const model = value.model ?? '';
  selectedModel.value = models.value.includes(model) ? model : '';
});
const statusLabel = computed(() => {
  return !config.value.configured
    ? t('ai.unconfigured')
    : config.value.validation?.status === 'valid'
      ? t('ai.valid')
      : config.value.validation?.status === 'failed'
        ? t('ai.failed')
        : t('ai.configured');
});
const statusClass = computed(() => {
  return !config.value.configured
    ? 'unconfigured'
    : config.value.validation?.status === 'valid'
      ? 'configured_valid'
      : config.value.validation?.status === 'failed'
        ? 'configured_invalid'
        : 'configured_unverified';
});
const validationNotice = computed(() => {
  return config.value.validation?.status === 'failed'
    ? t(`ai.failure.${config.value.validation.failureReason ?? 'request_failed'}`)
    : '';
});
const confirmDelete = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
onMounted(async () => {
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/${props.provider}`, { credentials: 'include' });
    if (!response.ok) throw await localizedResponseError(response);
    config.value = await response.json();
    window.dispatchEvent(new Event('integration-preferences-changed'));
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.requestFailed');
  } finally {
    loading.value = false;
  }
});

async function verify() {
  if (!canVerify.value) return;
  busy.value = true;
  testing.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  const key = apiKey.value.trim();
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/${props.provider}${key ? '' : '/test'}`, {
      method: key ? 'PUT' : 'POST',
      credentials: 'include',
      headers: { 'accept-language': locale.value, ...(key ? { 'content-type': 'application/json' } : {}) },
      ...(key ? { body: JSON.stringify({ apiKey: key }) } : {}),
    });
    if (!response.ok) throw await localizedResponseError(response);
    config.value = await response.json();
    window.dispatchEvent(new Event('integration-preferences-changed'));
    if (config.value.validation?.status === 'valid') {
      apiKey.value = '';
      successMessage.value = t('ai.saved');
    }
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.requestFailed');
  } finally {
    busy.value = false;
    testing.value = false;
  }
}

function requestDelete() {
  if (busy.value || !config.value.configured) return;
  successMessage.value = '';
  errorMessage.value = '';
  confirmDelete.value = true;
}

async function saveModel() {
  if (busy.value || !verified.value || !selectedModel.value || selectedModel.value === config.value.model) return;
  busy.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/${props.provider}/model`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'accept-language': locale.value },
      body: JSON.stringify({ model: selectedModel.value }),
    });
    if (!response.ok) throw await localizedResponseError(response);
    config.value = await response.json();
    window.dispatchEvent(new Event('integration-preferences-changed'));
    successMessage.value = t('ai.modelSaved');
  } catch (error) {
    selectedModel.value = config.value.model ?? '';
    errorMessage.value = localizedErrorMessage(error, 'errors.requestFailed');
  } finally {
    busy.value = false;
  }
}

async function remove() {
  if (busy.value || !config.value.configured || !confirmDelete.value) return;
  busy.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/${props.provider}`, { method: 'DELETE', credentials: 'include', headers: { 'accept-language': locale.value } });
    if (!response.ok) throw await localizedResponseError(response);
    config.value = { configured: false };
    window.dispatchEvent(new Event('integration-preferences-changed'));
    apiKey.value = '';
    confirmDelete.value = false;
    successMessage.value = t('ai.deleted');
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.requestFailed');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <IntegrationCard
    :id="props.provider"
    :title="t(`ai.provider.${props.provider}`)"
    badge="AI"
    :description="t('settings.aiSummary')"
    :status-label="statusLabel"
    :status-class="statusClass"
    :configured="config.configured"
    :busy="busy"
    :loading="loading"
    :notice="errorMessage || validationNotice"
  >
    <p v-if="loading" class="loading compact-loading">{{ t('ai.loading') }}</p>
    <form v-else class="integration-form" @submit.prevent="verify">
      <div class="settings-fields integration-fields">
        <label :for="`${props.provider}-api-key`">
          {{ t('ai.apiKey', { provider: t(`ai.provider.${props.provider}`) }) }} <span v-if="config.configured">({{ config.maskedApiKey }})</span>
          <input
            :id="`${props.provider}-api-key`"
            v-model="apiKey"
            type="password"
            autocomplete="new-password"
            minlength="20"
            maxlength="4096"
            :disabled="busy || confirmDelete"
            :placeholder="config.configured ? t('ai.replaceHint') : 'sk-…'"
          />
          <small>{{ t('ai.keyHint') }}</small>
        </label>
      </div>
      <p class="connection-note openai-test-hint">{{ t('ai.testHint') }}</p>
      <p v-if="config.validation" class="openai-test-detail">
        {{
          t('ai.checkedAt', {
            date: formatDate(config.validation.checkedAt, { dateStyle: 'medium', timeStyle: 'short' }),
          })
        }}
      </p>
      <p v-if="verified && config.model" class="openai-test-detail">{{ t('ai.currentModel', { model: config.model }) }}</p>
      <div v-if="verified" class="settings-fields integration-fields openai-model-fields">
        <label :for="`${props.provider}-model`">
          {{ t('ai.model') }}
          <span class="openai-model-select">
            <select
              :id="`${props.provider}-model`"
              class="ai-model-input"
              v-model="selectedModel"
              :disabled="busy || confirmDelete || !models.length"
              @change="saveModel"
            >
              <option disabled value="">{{ t('ai.chooseModel') }}</option>
              <option v-for="model in models" :key="model" :value="model">{{ model }}</option>
            </select>
            <svg class="openai-model-chevron" viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
              <path
                d="m4 6 4 4 4-4"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          <small>{{ t('ai.modelHint') }}</small>
          <small v-if="!models.length">{{ t('ai.noModels') }}</small>
        </label>
      </div>
      <div class="settings-card-footer integration-form-footer openai-footer">
        <div v-if="errorMessage || validationNotice || successMessage" class="settings-feedback integration-feedback">
          <p v-if="errorMessage" class="error settings-message" role="alert">{{ errorMessage }}</p>
          <p v-if="validationNotice && !errorMessage" class="error settings-message" role="alert">
            {{ validationNotice }}
          </p>
          <p v-if="successMessage" class="success settings-message" role="status">{{ successMessage }}</p>
        </div>
        <div v-if="confirmDelete" class="openai-delete-confirmation" role="group" :aria-labelledby="`${props.provider}-delete-prompt`">
          <p :id="`${props.provider}-delete-prompt`">{{ t('ai.deleteConfirm') }}</p>
          <div class="integration-actions">
            <button class="secondary" type="button" :disabled="busy" @click="confirmDelete = false">
              {{ t('qbittorrent.cancel') }}
            </button>
            <button class="secondary danger" type="button" :disabled="busy" @click="remove">
              {{ t('qbittorrent.confirmDelete') }}
            </button>
          </div>
        </div>
        <div v-else class="integration-actions">
          <button class="secondary danger" type="button" :disabled="busy || !config.configured" @click="requestDelete">
            {{ t('ai.delete') }}
          </button>
          <button class="primary openai-test-button" type="submit" :disabled="!canVerify">
            {{ testing ? t('ai.testing') : t('ai.test') }}
          </button>
        </div>
      </div>
    </form>
  </IntegrationCard>
</template>

<style scoped>
.openai-footer {
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 16px;
}
.openai-footer .integration-feedback {
  flex: 1 1 240px;
  overflow-wrap: anywhere;
}
.openai-delete-confirmation {
  display: grid;
  flex: 1 1 100%;
  min-width: 0;
  gap: 12px;
}
.openai-delete-confirmation p {
  margin: 0;
  overflow-wrap: anywhere;
}
.openai-delete-confirmation .integration-actions {
  justify-content: flex-end;
}
@media (max-width: 600px) {
  .openai-footer > .integration-actions {
    width: 100%;
  }
}

.openai-test-detail {
  margin: 0;
  color: #93988e;
  font-size: 0.73rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.openai-test-hint {
  margin: 0;
}
.openai-test-button {
  white-space: nowrap;
}
.openai-model-fields {
  grid-template-columns: minmax(0, 1fr);
  justify-items: start;
}
.openai-model-fields label {
  width: 100%;
  min-width: 0;
}
.openai-model-select {
  position: relative;
  display: block;
  width: min(100%, 360px);
}
.openai-model-chevron {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
  color: #b8bcb3;
}
.ai-model-input {
  appearance: none;
  -webkit-appearance: none;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 42px;
  padding: 10px 42px 10px 14px;
  border: 1px solid #292a2b;
  border-radius: 7px;
  background: #111314;
  color: inherit;
  font: inherit;
  text-overflow: ellipsis;
  color-scheme: dark;
}
.ai-model-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
