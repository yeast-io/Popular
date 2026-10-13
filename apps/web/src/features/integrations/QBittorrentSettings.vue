<script setup lang="ts">
import type {
  ApiError,
  IntegrationStatus,
  QBittorrentAuthMethod,
  QBittorrentConfiguration,
} from '@movie-hub/contract';
import { computed, onMounted, ref } from 'vue';
import { loadWebConfig } from '../../config/env';
import { formatDate, t } from '../../i18n';
import { localizedApiError, localizedErrorMessage } from '../../i18n/api-error';

const { apiBaseUrl } = loadWebConfig();
const config = ref<QBittorrentConfiguration>({ provider: 'qbittorrent', status: 'unconfigured' });
const baseUrl = ref('http://localhost:8080');
const authMethod = ref<QBittorrentAuthMethod>('api_key');
const apiKey = ref('');
const username = ref('');
const password = ref('');
const loading = ref(true);
const submitting = ref(false);
const deleting = ref(false);
const confirmDelete = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
const configured = computed(() => config.value.status !== 'unconfigured');
const statusLabel = computed(() => t(`qbittorrent.status.${config.value.status}` as `qbittorrent.status.${IntegrationStatus}`));

onMounted(loadConfiguration);

async function loadConfiguration() {
  loading.value = true;
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/qbittorrent`, { credentials: 'include' });
    if (!response.ok) throw localizedApiError(await response.json() as ApiError, 'errors.requestFailed');
    applyConfiguration(await response.json() as QBittorrentConfiguration);
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.serviceUnavailable');
  } finally { loading.value = false; }
}

async function testAndSave() {
  errorMessage.value = ''; successMessage.value = ''; submitting.value = true;
  const body = authMethod.value === 'api_key'
    ? { baseUrl: baseUrl.value.trim(), authMethod: 'api_key', ...(apiKey.value ? { apiKey: apiKey.value } : {}) }
    : {
        baseUrl: baseUrl.value.trim(), authMethod: 'username_password', username: username.value.trim(),
        ...(password.value ? { password: password.value } : {}),
      };
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/qbittorrent`, {
      method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json() as QBittorrentConfiguration | ApiError;
    if (!response.ok) throw localizedApiError(result, 'errors.qbittorrentValidation');
    applyConfiguration(result as QBittorrentConfiguration);
    apiKey.value = ''; password.value = '';
    successMessage.value = t('qbittorrent.saved');
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.qbittorrentValidation');
  } finally { submitting.value = false; }
}

async function retest() {
  errorMessage.value = ''; successMessage.value = ''; submitting.value = true;
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/qbittorrent/test`, { method: 'POST', credentials: 'include' });
    const result = await response.json() as QBittorrentConfiguration | ApiError;
    if (!response.ok) throw localizedApiError(result, 'errors.qbittorrentValidation');
    applyConfiguration(result as QBittorrentConfiguration);
    successMessage.value = t('qbittorrent.retested');
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.qbittorrentValidation');
  } finally { submitting.value = false; }
}

async function deleteConfiguration() {
  deleting.value = true; errorMessage.value = ''; successMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/qbittorrent`, { method: 'DELETE', credentials: 'include' });
    if (!response.ok) throw localizedApiError(await response.json() as ApiError, 'errors.requestFailed');
    applyConfiguration({ provider: 'qbittorrent', status: 'unconfigured' });
    confirmDelete.value = false;
    successMessage.value = t('qbittorrent.deleted');
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.requestFailed');
  } finally { deleting.value = false; }
}

function applyConfiguration(next: QBittorrentConfiguration) {
  config.value = next;
  baseUrl.value = next.baseUrl ?? 'http://localhost:8080';
  authMethod.value = next.authMethod ?? 'api_key';
  username.value = next.username ?? '';
}

function canSubmit(): boolean {
  if (!baseUrl.value.trim()) return false;
  if (authMethod.value === 'api_key') {
    return Boolean(apiKey.value) || (configured.value && config.value.authMethod === 'api_key');
  }
  const canRetainPassword = configured.value && config.value.authMethod === 'username_password' && config.value.username === username.value.trim();
  return Boolean(username.value.trim()) && (Boolean(password.value) || canRetainPassword);
}
</script>

<template>
  <section class="settings-card integration-card" aria-labelledby="qbittorrent-section-title" :aria-busy="loading || submitting || deleting">
    <div class="settings-card-heading compact integration-heading">
      <div>
        <div class="integration-title-row">
          <h2 id="qbittorrent-section-title">{{ t('qbittorrent.title') }}</h2>
          <span class="integration-status" :class="config.status">{{ statusLabel }}</span>
        </div>
        <p>{{ t('qbittorrent.description') }}</p>
      </div>
    </div>
    <div v-if="loading" class="loading compact-loading">{{ t('qbittorrent.loading') }}</div>
    <template v-else>
      <dl v-if="configured" class="integration-summary">
        <div><dt>{{ t('qbittorrent.currentBaseUrl') }}</dt><dd>{{ config.baseUrl }}</dd></div>
        <div><dt>{{ t('qbittorrent.version') }}</dt><dd>{{ config.version || '—' }}</dd></div>
        <div><dt>{{ t('qbittorrent.lastValidation') }}</dt><dd>{{ config.lastValidationAt ? formatDate(config.lastValidationAt, { dateStyle: 'medium', timeStyle: 'short' }) : '—' }}</dd></div>
      </dl>
      <form class="integration-form" novalidate @submit.prevent="testAndSave">
        <div class="settings-fields integration-fields">
          <label for="qbittorrent-base-url">
            {{ t('qbittorrent.baseUrl') }}
            <input id="qbittorrent-base-url" v-model="baseUrl" type="url" required maxlength="2048" autocomplete="url" />
            <small>{{ t('qbittorrent.baseUrlHint') }}</small>
          </label>
          <fieldset class="auth-method-fieldset">
            <legend>{{ t('qbittorrent.authMethod') }}</legend>
            <div class="auth-method-options">
              <button
                type="button"
                class="auth-method-option"
                :class="{ active: authMethod === 'api_key' }"
                :aria-pressed="authMethod === 'api_key'"
                @click="authMethod = 'api_key'"
              >
                {{ t('qbittorrent.auth.apiKey') }}
              </button>
              <button
                type="button"
                class="auth-method-option"
                :class="{ active: authMethod === 'username_password' }"
                :aria-pressed="authMethod === 'username_password'"
                @click="authMethod = 'username_password'"
              >
                {{ t('qbittorrent.auth.password') }}
              </button>
            </div>
          </fieldset>
          <label v-if="authMethod === 'api_key'" for="qbittorrent-api-key">
            {{ t('qbittorrent.apiKey') }}
            <input id="qbittorrent-api-key" v-model="apiKey" type="password" maxlength="4096" autocomplete="new-password" :placeholder="configured ? t('qbittorrent.keepSecret') : ''" />
          </label>
          <template v-else>
            <label for="qbittorrent-username">
              {{ t('qbittorrent.username') }}
              <input id="qbittorrent-username" v-model="username" maxlength="256" autocomplete="username" />
            </label>
            <label for="qbittorrent-password">
              {{ t('qbittorrent.password') }}
              <input id="qbittorrent-password" v-model="password" type="password" maxlength="4096" autocomplete="new-password" :placeholder="configured ? t('qbittorrent.keepSecret') : ''" />
            </label>
          </template>
        </div>
        <div class="settings-card-footer integration-form-footer">
          <div class="settings-feedback integration-feedback">
            <p v-if="errorMessage" class="error settings-message" role="alert">{{ errorMessage }}</p>
            <p v-if="successMessage" class="success settings-message" role="status">{{ successMessage }}</p>
          </div>
          <div class="integration-actions">
            <div v-if="configured && confirmDelete" class="integration-delete">
              <span>{{ t('qbittorrent.deleteConfirm') }}</span>
              <button class="secondary" type="button" :disabled="deleting" @click="confirmDelete = false">{{ t('qbittorrent.cancel') }}</button>
              <button class="secondary danger" type="button" :disabled="deleting" @click="deleteConfiguration">{{ t('qbittorrent.confirmDelete') }}</button>
            </div>
            <button v-else-if="configured" class="secondary danger integration-delete-trigger" type="button" :disabled="submitting || deleting" @click="confirmDelete = true">{{ t('qbittorrent.delete') }}</button>
            <button v-if="configured" class="secondary" type="button" :disabled="submitting || deleting" @click="retest">{{ t('qbittorrent.retest') }}</button>
            <button class="primary" type="submit" :disabled="submitting || deleting || !canSubmit()">{{ submitting ? t('qbittorrent.testing') : t('qbittorrent.testAndSave') }}</button>
          </div>
        </div>
      </form>
    </template>
  </section>
</template>
