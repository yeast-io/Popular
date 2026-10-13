<script setup lang="ts">
import {
  MTEAM_DEFAULT_BASE_URL,
  MTEAM_DEFAULT_WEB_BASE_URL,
  type ApiError,
  type IntegrationFailureType,
  type IntegrationStatus,
  type MTeamConfiguration,
} from '@movie-hub/contract';
import { computed, onMounted, ref } from 'vue';
import { loadWebConfig } from '../../config/env';
import { formatDate, t } from '../../i18n';
import { localizedApiError, localizedErrorMessage } from '../../i18n/api-error';

const { apiBaseUrl } = loadWebConfig();
const config = ref<MTeamConfiguration>({ provider: 'mteam', status: 'unconfigured' });
const baseUrl = ref(MTEAM_DEFAULT_BASE_URL);
const webBaseUrl = ref(MTEAM_DEFAULT_WEB_BASE_URL);
const apiKey = ref('');
const loading = ref(true);
const submitting = ref(false);
const deleting = ref(false);
const confirmDelete = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
const ACTION_TIMEOUT_MS = 15_000;
const STATUS_REFRESH_TIMEOUT_MS = 5_000;

const configured = computed(() => config.value.status !== 'unconfigured');
const statusLabel = computed(() => t(`mteam.status.${config.value.status}` as `mteam.status.${IntegrationStatus}`));
const failureLabel = computed(() => config.value.lastFailureType
  ? t(`mteam.failure.${config.value.lastFailureType}` as `mteam.failure.${IntegrationFailureType}`)
  : '');

onMounted(loadConfiguration);

async function loadConfiguration() {
  loading.value = true;
  try {
    const response = await timedFetch(`${apiBaseUrl}/me/integrations/mteam`, { credentials: 'include' }, ACTION_TIMEOUT_MS);
    if (!response.ok) throw localizedApiError(await response.json() as ApiError, 'errors.requestFailed');
    applyConfiguration(await response.json() as MTeamConfiguration);
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.serviceUnavailable');
  } finally {
    loading.value = false;
  }
}

async function testAndSave() {
  clearMessages();
  submitting.value = true;
  try {
    const response = await timedFetch(`${apiBaseUrl}/me/integrations/mteam`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: baseUrl.value.trim(),
        webBaseUrl: webBaseUrl.value.trim(),
        ...(apiKey.value ? { apiKey: apiKey.value } : {}),
      }),
    }, ACTION_TIMEOUT_MS);
    const result = await response.json() as MTeamConfiguration | ApiError;
    if (!response.ok) {
      applyFailureState(result);
      throw localizedApiError(result, 'errors.mteamValidation');
    }
    applyConfiguration(result as MTeamConfiguration);
    apiKey.value = '';
    successMessage.value = t('mteam.saved');
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.mteamValidation');
    void refreshAfterFailure();
  } finally {
    submitting.value = false;
  }
}

async function retest() {
  clearMessages();
  submitting.value = true;
  try {
    const response = await timedFetch(`${apiBaseUrl}/me/integrations/mteam/test`, {
      method: 'POST', credentials: 'include',
    }, ACTION_TIMEOUT_MS);
    const result = await response.json() as MTeamConfiguration | ApiError;
    if (!response.ok) {
      applyFailureState(result);
      throw localizedApiError(result, 'errors.mteamValidation');
    }
    applyConfiguration(result as MTeamConfiguration);
    successMessage.value = t('mteam.retested');
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.mteamValidation');
    void refreshAfterFailure();
  } finally {
    submitting.value = false;
  }
}

async function deleteConfiguration() {
  clearMessages();
  deleting.value = true;
  try {
    const response = await timedFetch(`${apiBaseUrl}/me/integrations/mteam`, {
      method: 'DELETE', credentials: 'include',
    }, ACTION_TIMEOUT_MS);
    if (!response.ok) throw localizedApiError(await response.json() as ApiError, 'errors.requestFailed');
    applyConfiguration({ provider: 'mteam', status: 'unconfigured' });
    apiKey.value = '';
    confirmDelete.value = false;
    successMessage.value = t('mteam.deleted');
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.requestFailed');
  } finally {
    deleting.value = false;
  }
}

async function refreshAfterFailure() {
  try {
    const response = await timedFetch(
      `${apiBaseUrl}/me/integrations/mteam`,
      { credentials: 'include' },
      STATUS_REFRESH_TIMEOUT_MS,
    );
    if (response.ok) applyConfiguration(await response.json() as MTeamConfiguration);
  } catch {
    // The primary validation result is already visible. A status refresh must never keep the form busy.
  }
}

function applyFailureState(result: MTeamConfiguration | ApiError) {
  if (!configured.value || !('error' in result)) return;
  const failureType = (result.error.details as { failureType?: unknown } | undefined)?.failureType;
  if (!isFailureType(failureType)) return;
  config.value = { ...config.value, status: 'configured_invalid', lastFailureType: failureType };
}

function applyConfiguration(next: MTeamConfiguration) {
  config.value = next;
  baseUrl.value = next.baseUrl ?? MTEAM_DEFAULT_BASE_URL;
  webBaseUrl.value = next.webBaseUrl ?? MTEAM_DEFAULT_WEB_BASE_URL;
}

function clearMessages() {
  errorMessage.value = '';
  successMessage.value = '';
  confirmDelete.value = false;
}

function timedFetch(input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function isFailureType(value: unknown): value is IntegrationFailureType {
  return ['authentication', 'network', 'timeout', 'invalid_response', 'remote_error'].includes(String(value));
}
</script>

<template>
  <section class="settings-card integration-card" aria-labelledby="mteam-section-title" :aria-busy="loading || submitting || deleting">
    <div class="settings-card-heading compact integration-heading">
      <div>
        <div class="integration-title-row">
          <h2 id="mteam-section-title">{{ t('mteam.title') }}</h2>
          <span class="integration-status" :class="config.status">{{ statusLabel }}</span>
        </div>
        <p>{{ t('mteam.description') }}</p>
      </div>
    </div>

    <div v-if="loading" class="loading compact-loading">{{ t('mteam.loading') }}</div>
    <template v-else>
      <dl v-if="configured" class="integration-summary">
        <div><dt>{{ t('mteam.currentBaseUrl') }}</dt><dd>{{ config.baseUrl }}</dd></div>
        <div><dt>{{ t('mteam.currentWebBaseUrl') }}</dt><dd>{{ config.webBaseUrl }}</dd></div>
        <div><dt>{{ t('mteam.lastValidation') }}</dt><dd>{{ config.lastValidationAt ? formatDate(config.lastValidationAt, { dateStyle: 'medium', timeStyle: 'short' }) : t('mteam.neverValidated') }}</dd></div>
        <div v-if="config.lastFailureType"><dt>{{ t('mteam.lastFailure') }}</dt><dd>{{ failureLabel }}</dd></div>
      </dl>

      <form class="integration-form" novalidate @submit.prevent="testAndSave">
        <div class="settings-fields integration-fields">
          <label for="mteam-base-url">
            {{ t('mteam.baseUrl') }}
            <input id="mteam-base-url" v-model="baseUrl" type="url" inputmode="url" maxlength="2048" required autocomplete="url" />
            <small>{{ t('mteam.baseUrlHint') }}</small>
          </label>
          <label for="mteam-web-base-url">
            {{ t('mteam.webBaseUrl') }}
            <input id="mteam-web-base-url" v-model="webBaseUrl" type="url" inputmode="url" maxlength="2048" required autocomplete="url" />
            <small>{{ t('mteam.webBaseUrlHint') }}</small>
          </label>
          <label for="mteam-api-key">
            {{ t('mteam.apiKey') }}
            <input id="mteam-api-key" v-model="apiKey" type="password" maxlength="4096" :required="!configured" autocomplete="new-password" :placeholder="configured ? t('mteam.replaceKeyPlaceholder') : t('mteam.keyPlaceholder')" />
            <small>{{ t('mteam.apiKeyHint') }}</small>
          </label>
        </div>
        <div class="settings-card-footer integration-form-footer">
          <div class="settings-feedback integration-feedback">
            <p v-if="errorMessage" class="error settings-message" role="alert">{{ errorMessage }}</p>
            <p v-if="successMessage" class="success settings-message" role="status" aria-live="polite">{{ successMessage }}</p>
          </div>
          <div class="integration-actions">
            <div v-if="configured && confirmDelete" class="integration-delete">
              <span>{{ t('mteam.deleteConfirm') }}</span>
              <button class="secondary" type="button" :disabled="deleting" @click="confirmDelete = false">{{ t('mteam.cancel') }}</button>
              <button class="secondary danger" type="button" :disabled="deleting" @click="deleteConfiguration">{{ deleting ? t('mteam.deleting') : t('mteam.confirmDelete') }}</button>
            </div>
            <button v-else-if="configured" class="secondary danger integration-delete-trigger" type="button" :disabled="submitting || deleting" @click="confirmDelete = true">{{ t('mteam.delete') }}</button>
            <button v-if="configured" class="secondary" type="button" :disabled="submitting || deleting" @click="retest">
              {{ submitting ? t('mteam.testing') : t('mteam.retest') }}
            </button>
            <button class="primary" type="submit" :disabled="submitting || deleting || !baseUrl.trim() || !webBaseUrl.trim() || (!configured && !apiKey)">
              {{ submitting ? t('mteam.testing') : t('mteam.testAndSave') }}
            </button>
          </div>
        </div>
      </form>
    </template>
  </section>
</template>
