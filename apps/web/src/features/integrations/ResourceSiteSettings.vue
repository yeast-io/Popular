<script setup lang="ts">
import { replacementSecret } from './integration-secret.domain';
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import type { ResourceSiteConfiguration, ApiError } from '@movie-hub/contract';
import SourceConfigurationActions from './SourceConfigurationActions.vue';
import IntegrationCard from '../settings/IntegrationCard.vue';
import { loadWebConfig } from '../../config/env';
import { t } from '../../i18n';
import { apiErrorKey, LocalizedApiError, localizedErrorMessage } from '../../i18n/api-error';
import type { TranslationKey } from '../../i18n/translation.types';

const emit = defineEmits<{ 'configuration-changed': [] }>();
const { apiBaseUrl } = loadWebConfig();
const configuration = ref<ResourceSiteConfiguration>({ site: 'hdarea', status: 'unconfigured' });
const cookie = ref('');
const passkey = ref('');
const busy = ref(false);
const deleting = ref(false);
const loading = ref(true);
const confirmDelete = ref(false);
const notice = ref('');
const feedback = ref('');
let controller: AbortController | undefined;
const configured = computed(() => configuration.value.status !== 'unconfigured');
const endpoint = `${apiBaseUrl}/me/integrations/resource-sites/hdarea`;
onMounted(async () => {
  await action(async () => { applyConfiguration(await request(endpoint)); });
  loading.value = false;
});
onBeforeUnmount(() => controller?.abort());

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  controller = new AbortController();
  const response = await fetch(url, { ...init, credentials: 'include', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
  if (response.status === 204) return undefined as T;
  const result = await response.json();
  if (!response.ok) {
    const reason = (result as ApiError).error?.details as { reason?: string } | undefined;
    const key = `resourceSite.error.${reason?.reason ?? 'network'}`;
    throw new LocalizedApiError(key in errorKeys ? key as TranslationKey : apiErrorKey(result, 'resourceSite.error.network'));
  }
  return result as T;
}
const errorKeys = {
  'resourceSite.error.notConfigured': true, 'resourceSite.error.authentication': true,
  'resourceSite.error.blocked': true, 'resourceSite.error.rateLimited': true,
  'resourceSite.error.invalidResponse': true, 'resourceSite.error.network': true,
  'resourceSite.error.timeout': true, 'resourceSite.error.invalidCredential': true,
};
async function action(work: () => Promise<void>) {
  busy.value = true; notice.value = ''; feedback.value = '';
  try { await work(); }
  catch (error) {
    notice.value = localizedErrorMessage(error, 'resourceSite.error.network');
    if (configured.value && error instanceof LocalizedApiError &&
      ['resourceSite.error.authentication', 'resourceSite.error.blocked'].includes(error.translationKey))
      configuration.value = { ...configuration.value, status: 'configured_invalid' };
  }
  finally { busy.value = false; }
}
function applyConfiguration(next: ResourceSiteConfiguration) {
  configuration.value = next;
  cookie.value = next.cookieMasked ?? '';
  passkey.value = next.passkeyMasked ?? '';
}
async function save() {
  confirmDelete.value = false;
  await action(async () => {
    applyConfiguration(await request<ResourceSiteConfiguration>(
      endpoint,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(
        {
          ...(replacementSecret(
            cookie.value, configuration.value.cookieMasked
          ) ? { cookie: replacementSecret(
            cookie.value, configuration.value.cookieMasked
          ) } : {}),
          ...(replacementSecret(
            passkey.value, configuration.value.passkeyMasked
          ) ? { passkey: replacementSecret(
            passkey.value, configuration.value.passkeyMasked
          ) } : {}),
        }
      ) }
    )
    );
    emit('configuration-changed');
    feedback.value = t('resourceSite.saved');
  });
}
async function remove() {
  deleting.value = true;
  await action(async () => {
    await request(endpoint, { method: 'DELETE' });
    applyConfiguration({ site: 'hdarea', status: 'unconfigured' }); confirmDelete.value = false;
    emit('configuration-changed');
  });
  deleting.value = false;
}
async function retest() {
  confirmDelete.value = false;
  await action(async () => {
    applyConfiguration(await request<ResourceSiteConfiguration>(`${endpoint}/test`, { method: 'POST' }));
    feedback.value = t('resourceSite.retested');
    emit('configuration-changed');
  });
}
</script>

<template>
  <IntegrationCard id="hdarea" :title="t('resourceSite.title')" badge="HD" :description="t('resourceSite.description')"
    :status-label="t(`mteam.status.${configuration.status}`)" :status-class="configuration.status"
    :configured="configured" :busy="busy" :loading="loading" :notice="notice">
    <template v-if="!loading">
      <form class="integration-form" novalidate @submit.prevent="save">
        <div class="settings-fields integration-fields">
          <label for="hdarea-cookie">{{ t('resourceSite.cookie') }}
            <input id="hdarea-cookie" v-model="cookie" :type="configuration.cookieMasked && cookie === configuration.cookieMasked ? 'text' : 'password'" autocomplete="new-password" maxlength="16384" :required="!configured" :disabled="busy" />
            <small v-if="configuration.cookieMasked">{{ t('settings.credentialLength', { length: Array.from(configuration.cookieMasked).length }) }}</small>
            <small>{{ t('resourceSite.cookieHint') }}</small>
          </label>
          <label for="hdarea-passkey">{{ t('resourceSite.passkey') }}
            <input id="hdarea-passkey" v-model="passkey" :type="configuration.passkeyMasked && passkey === configuration.passkeyMasked ? 'text' : 'password'" autocomplete="new-password" maxlength="512" :disabled="busy" />
            <small v-if="configuration.passkeyMasked">{{ t('settings.credentialLength', { length: Array.from(configuration.passkeyMasked).length }) }}</small>
            <small>{{ t('resourceSite.passkeyHint') }}</small>
          </label>
        </div>
        <div class="settings-card-footer integration-form-footer">
          <div class="settings-feedback integration-feedback">
            <p v-if="notice" class="error settings-message" role="alert">{{ notice }}</p>
            <p v-if="feedback" class="success settings-message" role="status" aria-live="polite">{{ feedback }}</p>
          </div>
          <SourceConfigurationActions
            v-model:confirm-delete="confirmDelete"
            :configured="configured"
            :busy="busy"
            :deleting="deleting"
            :delete-prompt="t('resourceSite.deleteConfirm')"
            :can-save="configured || Boolean(cookie.trim())"
            @delete="remove"
            @retest="retest"
          />
        </div>
      </form>
      <p v-if="busy" role="status">{{ t('resourceSite.working') }}</p>
    </template>
  </IntegrationCard>
</template>
