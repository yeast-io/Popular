<script setup lang="ts">
import { replacementSecret } from './integration-secret.domain';
import IntegrationCard from '../settings/IntegrationCard.vue';
import type { ApiError, IntegrationStatus, QBittorrentAuthMethod, QBittorrentConfiguration } from '@movie-hub/contract';
import { computed, onMounted, ref, watch } from 'vue';
import { loadWebConfig } from '../../config/env';
import { formatDate, t } from '../../i18n';
import { localizedApiError, localizedErrorMessage } from '../../i18n/api-error';

const { apiBaseUrl } = loadWebConfig();
const props = defineProps<{ instance?: QBittorrentConfiguration; creating?: boolean; embedded?: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const config = ref<QBittorrentConfiguration>({ provider: 'qbittorrent', status: 'unconfigured' });
const name = ref(props.creating ? '' : 'qBittorrent');
const baseUrl = ref('');
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
const fieldPrefix = computed(() => props.instance?.downloaderInstanceId ? `qbittorrent-${props.instance.downloaderInstanceId}` : 'qbittorrent');
const statusLabel = computed(() => {
  return t(`qbittorrent.status.${config.value.status}` as `qbittorrent.status.${IntegrationStatus}`);
});

onMounted(() => {
  if (props.instance) {
    applyConfiguration(props.instance);
    loading.value = false;
  } else if (props.creating) {
    loading.value = false;
  } else {
    void loadConfiguration();
  }
});
watch(() => props.instance, (next) => {
  if (next) applyConfiguration(next);
});

async function loadConfiguration() {
  loading.value = true;
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/qbittorrent`, { credentials: 'include' });
    if (!response.ok) throw localizedApiError((await response.json()) as ApiError, 'errors.requestFailed');
    applyConfiguration((await response.json()) as QBittorrentConfiguration);
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
  const body
    = authMethod.value === 'api_key'
      ? { name: name.value.trim(), baseUrl: baseUrl.value.trim(), authMethod: 'api_key', ...(replacementSecret(apiKey.value, config.value.apiKeyMasked) ? { apiKey: replacementSecret(apiKey.value, config.value.apiKeyMasked) } : {}) }
      : {
          name: name.value.trim(),
          baseUrl: baseUrl.value.trim(),
          authMethod: 'username_password',
          username: username.value.trim(),
          ...(replacementSecret(password.value, config.value.passwordMasked) ? { password: replacementSecret(password.value, config.value.passwordMasked) } : {}),
        };
  try {
    const endpoint = props.creating
      ? '/me/integrations/qbittorrent/instances'
      : props.instance?.downloaderInstanceId
        ? `/me/integrations/qbittorrent/instances/${props.instance.downloaderInstanceId}`
        : '/me/integrations/qbittorrent';
    const response = await fetch(`${apiBaseUrl}${endpoint}`, {
      method: props.creating ? 'POST' : 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as QBittorrentConfiguration | ApiError;
    if (!response.ok) throw localizedApiError(result, 'errors.qbittorrentValidation');
    applyConfiguration(result as QBittorrentConfiguration);
    successMessage.value = t('qbittorrent.saved');
    emit('changed');
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.qbittorrentValidation');
  } finally {
    submitting.value = false;
  }
}

async function deleteConfiguration() {
  deleting.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    const endpoint = props.instance?.downloaderInstanceId
      ? `/me/integrations/qbittorrent/instances/${props.instance.downloaderInstanceId}`
      : '/me/integrations/qbittorrent';
    const response = await fetch(`${apiBaseUrl}${endpoint}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!response.ok) throw localizedApiError((await response.json()) as ApiError, 'errors.requestFailed');
    applyConfiguration({ provider: 'qbittorrent', status: 'unconfigured' });
    confirmDelete.value = false;
    successMessage.value = t('qbittorrent.deleted');
    emit('changed');
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.requestFailed');
  } finally {
    deleting.value = false;
  }
}

function applyConfiguration(next: QBittorrentConfiguration) {
  config.value = next;
  name.value = next.name ?? 'qBittorrent';
  apiKey.value = next.apiKeyMasked ?? '';
  password.value = next.passwordMasked ?? '';
  baseUrl.value = next.baseUrl ?? '';
  authMethod.value = next.authMethod ?? 'api_key';
  username.value = next.username ?? '';
}

function canSubmit(): boolean {
  if (!name.value.trim()) return false;
  if (!baseUrl.value.trim()) return false;
  if (authMethod.value === 'api_key') {
    return Boolean(replacementSecret(apiKey.value, config.value.apiKeyMasked)) || (configured.value && config.value.authMethod === 'api_key');
  }
  const canRetainPassword
    = configured.value
      && config.value.authMethod === 'username_password'
      && config.value.username === username.value.trim();
  return Boolean(username.value.trim()) && (Boolean(replacementSecret(password.value, config.value.passwordMasked)) || canRetainPassword);
}
</script>

<template>
  <IntegrationCard
    :id="config.downloaderInstanceId ?? (creating ? 'new-qbittorrent' : 'qbittorrent')"
    provider="qbittorrent"
    :default-id="config.downloaderInstanceId ?? 'qbittorrent'"
    :title="creating ? t('downloader.addQBittorrent') : (config.name ?? t('qbittorrent.title'))"
    badge="qB"
    :status-label="statusLabel"
    :status-class="config.status"
    :configured="configured"
    :busy="submitting || deleting"
    :loading="loading"
    :notice="errorMessage"
    :force-open="creating"
    :embedded="embedded"
  >
    <div v-if="loading" class="loading compact-loading">{{ t('qbittorrent.loading') }}</div>
    <template v-else>
      <dl v-if="configured" class="integration-summary">
        <div>
          <dt>{{ t('qbittorrent.currentBaseUrl') }}</dt>
          <dd>{{ config.baseUrl }}</dd>
        </div>
        <div>
          <dt>{{ t('qbittorrent.version') }}</dt>
          <dd>{{ config.version || '—' }}</dd>
        </div>
        <div>
          <dt>{{ t('qbittorrent.lastValidation') }}</dt>
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
        <div class="settings-fields integration-fields downloader-fields">
          <label :for="`${fieldPrefix}-name`">
            {{ t('downloader.name') }}
            <input :id="`${fieldPrefix}-name`" v-model="name" required maxlength="80" />
          </label>
          <label :for="`${fieldPrefix}-base-url`">
            {{ t('qbittorrent.baseUrl') }}
            <input
              :id="`${fieldPrefix}-base-url`"
              v-model="baseUrl"
              type="url"
              required
              maxlength="2048"
              autocomplete="url"
              :placeholder="t('qbittorrent.baseUrlPlaceholder')"
            />
            <small>{{ t('qbittorrent.baseUrlHint') }}</small>
          </label>
          <fieldset class="auth-method-fieldset">
            <legend>{{ t('qbittorrent.authMethod') }}</legend>
            <div class="auth-method-options">
              <label class="auth-method-option">
                <input v-model="authMethod" type="radio" :name="`${fieldPrefix}-auth-method`" value="api_key" />
                <span>{{ t('qbittorrent.auth.apiKey') }}</span>
              </label>
              <label class="auth-method-option">
                <input v-model="authMethod" type="radio" :name="`${fieldPrefix}-auth-method`" value="username_password" />
                <span>{{ t('qbittorrent.auth.password') }}</span>
              </label>
            </div>
          </fieldset>
          <label v-if="authMethod === 'api_key'" :for="`${fieldPrefix}-api-key`">
            {{ t('qbittorrent.apiKey') }}
            <input
              :id="`${fieldPrefix}-api-key`"
              v-model="apiKey"
              :type="config.apiKeyMasked && apiKey === config.apiKeyMasked ? 'text' : 'password'"
              maxlength="4096"
              autocomplete="new-password"
              :placeholder="configured ? t('qbittorrent.keepSecret') : ''"
            />
            <small v-if="config.apiKeyMasked">{{ t('settings.credentialLength', { length: Array.from(config.apiKeyMasked).length }) }}</small>
          </label>
          <template v-else>
            <label :for="`${fieldPrefix}-username`">
              {{ t('qbittorrent.username') }}
              <input :id="`${fieldPrefix}-username`" v-model="username" maxlength="256" autocomplete="username" />
            </label>
            <label :for="`${fieldPrefix}-password`">
              {{ t('qbittorrent.password') }}
              <input
                :id="`${fieldPrefix}-password`"
                v-model="password"
                :type="config.passwordMasked && password === config.passwordMasked ? 'text' : 'password'"
                maxlength="4096"
                autocomplete="new-password"
                :placeholder="configured ? t('qbittorrent.keepSecret') : ''"
              />
              <small v-if="config.passwordMasked">{{ t('settings.credentialLength', { length: Array.from(config.passwordMasked).length }) }}</small>
            </label>
          </template>
        </div>
        <div class="settings-card-footer integration-form-footer downloader-form-footer">
          <div class="settings-feedback integration-feedback">
            <p v-if="errorMessage" class="error settings-message" role="alert">{{ errorMessage }}</p>
            <p v-if="successMessage" class="success settings-message" role="status">{{ successMessage }}</p>
          </div>
          <div class="integration-actions">
            <div v-if="configured && confirmDelete" class="integration-delete">
              <span>{{ t('qbittorrent.deleteConfirm') }}</span>
              <button class="secondary" type="button" :disabled="deleting" @click="confirmDelete = false">
                {{ t('qbittorrent.cancel') }}
              </button>
              <button class="secondary danger" type="button" :disabled="deleting" @click="deleteConfiguration">
                {{ t('qbittorrent.confirmDelete') }}
              </button>
            </div>
            <button
              v-else-if="configured"
              class="secondary danger integration-delete-trigger"
              type="button"
              :disabled="submitting || deleting"
              @click="confirmDelete = true"
            >
              {{ t('qbittorrent.delete') }}
            </button>
            <button class="primary" type="submit" :disabled="submitting || deleting || !canSubmit()">
              {{ submitting ? t('qbittorrent.testing') : t('qbittorrent.testAndSave') }}
            </button>
          </div>
        </div>
      </form>
    </template>
  </IntegrationCard>
</template>
