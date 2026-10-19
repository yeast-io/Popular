<script setup lang="ts">
import IntegrationCard from '../settings/IntegrationCard.vue';
import type { ApiError, IntegrationStatus, TransmissionConfiguration } from '@movie-hub/contract';
import { computed, onMounted, ref } from 'vue';
import { loadWebConfig } from '../../config/env';
import { formatDate, t } from '../../i18n';
import { localizedApiError, localizedErrorMessage } from '../../i18n/api-error';

const { apiBaseUrl } = loadWebConfig();
const config = ref<TransmissionConfiguration>({ provider: 'transmission', status: 'unconfigured' });
const baseUrl = ref('http://localhost:9091');
const username = ref('');
const password = ref('');
const loading = ref(true);
const submitting = ref(false);
const deleting = ref(false);
const confirmDelete = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
const configured = computed(() => config.value.status !== 'unconfigured');
const statusLabel = computed(() => {
  return t(`transmission.status.${config.value.status}` as `transmission.status.${IntegrationStatus}`);
});

onMounted(loadConfiguration);

async function loadConfiguration() {
  loading.value = true;
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/transmission`, { credentials: 'include' });
    if (!response.ok) throw localizedApiError((await response.json()) as ApiError, 'errors.requestFailed');
    applyConfiguration((await response.json()) as TransmissionConfiguration);
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.serviceUnavailable');
  } finally {
    loading.value = false;
  }
}

async function testAndSave() {
  errorMessage.value = '';
  successMessage.value = '';
  submitting.value = true;
  const body = {
    baseUrl: baseUrl.value.trim(),
    username: username.value.trim(),
    ...(password.value ? { password: password.value } : {}),
  };
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/transmission`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as TransmissionConfiguration | ApiError;
    if (!response.ok) throw localizedApiError(result, 'errors.transmissionValidation');
    applyConfiguration(result as TransmissionConfiguration);
    password.value = '';
    successMessage.value = t('transmission.saved');
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.transmissionValidation');
  } finally {
    submitting.value = false;
  }
}

async function retest() {
  errorMessage.value = '';
  successMessage.value = '';
  submitting.value = true;
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/transmission/test`, {
      method: 'POST',
      credentials: 'include',
    });
    const result = (await response.json()) as TransmissionConfiguration | ApiError;
    if (!response.ok) throw localizedApiError(result, 'errors.transmissionValidation');
    applyConfiguration(result as TransmissionConfiguration);
    successMessage.value = t('transmission.retested');
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.transmissionValidation');
    await loadConfiguration();
  } finally {
    submitting.value = false;
  }
}

async function deleteConfiguration() {
  deleting.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/transmission`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!response.ok) throw localizedApiError((await response.json()) as ApiError, 'errors.requestFailed');
    applyConfiguration({ provider: 'transmission', status: 'unconfigured' });
    password.value = '';
    confirmDelete.value = false;
    successMessage.value = t('transmission.deleted');
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.requestFailed');
  } finally {
    deleting.value = false;
  }
}

function applyConfiguration(next: TransmissionConfiguration) {
  config.value = next;
  baseUrl.value = next.baseUrl ?? 'http://localhost:9091';
  username.value = next.username ?? '';
}

function canSubmit(): boolean {
  if (!baseUrl.value.trim()) return false;
  const canRetainPassword =
    configured.value &&
    config.value.baseUrl === baseUrl.value.trim().replace(/\/$/, '') &&
    config.value.username === username.value.trim();
  return Boolean(username.value.trim()) && (Boolean(password.value) || canRetainPassword);
}
</script>

<template>
  <IntegrationCard
    id="transmission"
    :title="t('transmission.title')"
    badge="Tr"
    :description="t('settings.transmissionSummary')"
    :status-label="statusLabel"
    :status-class="config.status"
    :configured="configured"
    :busy="submitting || deleting"
    :loading="loading"
    :notice="errorMessage"
  >
    <div v-if="loading" class="loading compact-loading">{{ t('transmission.loading') }}</div>
    <template v-else>
      <dl v-if="configured" class="integration-summary">
        <div>
          <dt>{{ t('transmission.currentBaseUrl') }}</dt>
          <dd>{{ config.baseUrl }}</dd>
        </div>
        <div>
          <dt>{{ t('transmission.version') }}</dt>
          <dd>{{ config.version || '—' }}</dd>
        </div>
        <div>
          <dt>{{ t('transmission.lastValidation') }}</dt>
          <dd>
            {{
              config.lastValidationAt
                ? formatDate(config.lastValidationAt, { dateStyle: 'medium', timeStyle: 'short' })
                : '—'
            }}
          </dd>
        </div>
      </dl>
      <form class="integration-form" novalidate @submit.prevent="testAndSave">
        <div class="settings-fields integration-fields">
          <label for="transmission-base-url">
            {{ t('transmission.baseUrl') }}
            <input
              id="transmission-base-url"
              v-model="baseUrl"
              type="url"
              required
              maxlength="2048"
              autocomplete="url"
            />
            <small>{{ t('transmission.baseUrlHint') }}</small>
          </label>
          <div class="transmission-credentials">
            <label for="transmission-username">
              {{ t('transmission.username') }}
              <input id="transmission-username" v-model="username" required maxlength="256" autocomplete="username" />
            </label>
            <label for="transmission-password">
              {{ t('transmission.password') }}
              <input
                id="transmission-password"
                v-model="password"
                type="password"
                maxlength="4096"
                autocomplete="new-password"
                :placeholder="configured ? t('transmission.keepSecret') : ''"
              />
            </label>
          </div>
        </div>
        <div class="settings-card-footer integration-form-footer">
          <div class="settings-feedback integration-feedback">
            <p v-if="errorMessage" class="error settings-message" role="alert">{{ errorMessage }}</p>
            <p v-if="successMessage" class="success settings-message" role="status">{{ successMessage }}</p>
          </div>
          <div class="integration-actions">
            <div v-if="configured && confirmDelete" class="integration-delete">
              <span>{{ t('transmission.deleteConfirm') }}</span>
              <button class="secondary" type="button" :disabled="deleting" @click="confirmDelete = false">
                {{ t('transmission.cancel') }}
              </button>
              <button class="secondary danger" type="button" :disabled="deleting" @click="deleteConfiguration">
                {{ t('transmission.confirmDelete') }}
              </button>
            </div>
            <button
              v-else-if="configured"
              class="secondary danger integration-delete-trigger"
              type="button"
              :disabled="submitting || deleting"
              @click="confirmDelete = true"
            >
              {{ t('transmission.delete') }}
            </button>
            <button
              v-if="configured"
              class="secondary"
              type="button"
              :disabled="submitting || deleting"
              @click="retest"
            >
              {{ t('transmission.retest') }}
            </button>
            <button class="primary" type="submit" :disabled="submitting || deleting || !canSubmit()">
              {{ submitting ? t('transmission.testing') : t('transmission.testAndSave') }}
            </button>
          </div>
        </div>
      </form>
    </template>
  </IntegrationCard>
</template>

<style scoped>
.transmission-credentials {
  display: grid;
  align-content: start;
  min-width: 0;
  gap: 22px;
}
</style>
