<script setup lang="ts">
import { replacementSecret } from './integration-secret.domain';
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import type { ResourceSiteConfiguration } from '@movie-hub/contract';
import SourceConfigurationActions from './SourceConfigurationActions.vue';
import IntegrationCard from '../settings/IntegrationCard.vue';
import { loadWebConfig } from '../../config/env';
import { formatDate, t } from '../../i18n';
import { localizedApiError, LocalizedApiError, localizedErrorMessage } from '../../i18n/api-error';

const props = withDefaults(defineProps<{ site?: string; name?: string }>(), { site: 'hdarea', name: 'HDArea' });
const emit = defineEmits<{ 'configuration-changed': [] }>();
const { apiBaseUrl } = loadWebConfig();
const configuration = ref<ResourceSiteConfiguration>({ site: props.site, status: 'unconfigured' });
const credential = ref('');
const usesApiKey = computed(() => props.site === 'hdarea');
const apiAddress = computed(() => {
  try {
    return configuration.value.baseUrl ? new URL('/api/v1/', configuration.value.baseUrl).href : '';
  } catch {
    return '';
  }
});
const masked = computed(() => (usesApiKey.value ? configuration.value.apiKeyMasked : configuration.value.cookieMasked));
const busy = ref(false);
const loading = ref(true);
const notice = ref('');
const feedback = ref('');
let controller: AbortController | undefined;
const configured = computed(() => configuration.value.status !== 'unconfigured');
const endpoint = `${apiBaseUrl}/me/integrations/resource-sites/${props.site}`;
onMounted(async () => {
  await action(async () => {
    applyConfiguration(await request(endpoint));
  });
  loading.value = false;
});
onBeforeUnmount(() => controller?.abort());

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  controller = new AbortController();
  const response = await fetch(url, {
    ...init,
    credentials: 'include',
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
  });
  if (response.status === 204) return undefined as T;
  const result = await response.json();
  if (!response.ok) throw localizedApiError(result, 'resourceSite.error.network');
  return result as T;
}
async function action(work: () => Promise<void>, revalidating = false) {
  busy.value = true;
  notice.value = '';
  feedback.value = '';
  try {
    await work();
  } catch (error) {
    notice.value = `${props.name}: ${localizedErrorMessage(error, 'resourceSite.error.network')}`;
    if (
      revalidating
      && configured.value
      && error instanceof LocalizedApiError
      && ['resourceSite.error.authentication', 'resourceSite.error.blocked'].includes(error.translationKey)
    )
      configuration.value = { ...configuration.value, status: 'configured_invalid' };
  } finally {
    busy.value = false;
  }
}
function applyConfiguration(next: ResourceSiteConfiguration) {
  configuration.value = next;
  credential.value = (usesApiKey.value ? next.apiKeyMasked : next.cookieMasked) ?? '';
}
async function save() {
  const replacement = replacementSecret(credential.value, masked.value);
  await action(async () => {
    applyConfiguration(
      await request<ResourceSiteConfiguration>(endpoint, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(replacement ? { [usesApiKey.value ? 'apiKey' : 'cookie']: replacement } : {}),
        }),
      })
    );
    emit('configuration-changed');
    feedback.value = t('sourceActions.saved');
  }, !replacement);
}
</script>

<template>
  <IntegrationCard
    :id="props.site"
    :title="props.name"
    badge="HD"
    :description="t(usesApiKey ? 'resourceSite.apiDescription' : 'resourceSite.description', { site: props.name })"
    :status-label="t(`mteam.status.${configuration.status}`)"
    :status-class="configuration.status"
    static-form
    :configured="configured"
    :busy="busy"
    :loading="loading"
    :notice="notice"
  >
    <template v-if="!loading">
      <form class="integration-form resource-site-form" novalidate @submit.prevent="save">
        <div class="settings-fields integration-fields">
          <label v-if="usesApiKey && configuration.baseUrl" :for="`${props.site}-api-url`"
            >{{ t('resourceSite.apiAddress') }}
            <input :id="`${props.site}-api-url`" :value="apiAddress" type="url" readonly autocomplete="url" />
          </label>
          <label :for="`${props.site}-base-url`"
            >{{ t('resourceSite.webAddress') }}
            <input
              :id="`${props.site}-base-url`"
              :value="configuration.baseUrl"
              type="url"
              readonly
              autocomplete="url"
            />
            <small>{{ t('resourceSite.addressHint') }}</small>
          </label>
          <p v-if="configuration.credentialUpdateRequired" class="error settings-message" role="alert">
            {{ t('resourceSite.error.apiKeyRequired') }}
          </p>
          <label :for="`${props.site}-${usesApiKey ? 'api-key' : 'cookie'}`"
            >{{ t(usesApiKey ? 'resourceSite.apiKey' : 'resourceSite.cookie') }}
            <input
              :id="`${props.site}-${usesApiKey ? 'api-key' : 'cookie'}`"
              v-model="credential"
              :type="masked && credential === masked ? 'text' : 'password'"
              autocomplete="new-password"
              :maxlength="usesApiKey ? 32 : 16384"
              :required="!configured || configuration.credentialUpdateRequired"
              :disabled="busy"
            />
            <small v-if="masked">{{ t('settings.credentialLength', { length: Array.from(masked).length }) }}</small>
            <small>{{
              t(usesApiKey ? 'resourceSite.apiKeyHint' : 'resourceSite.cookieHint', { site: props.name })
            }}</small>
          </label>
        </div>
        <dl v-if="configured" class="integration-summary">
          <div>
            <dt>{{ t('resourceSite.lastValidation') }}</dt>
            <dd>
              {{
                configuration.verifiedAt
                  ? formatDate(configuration.verifiedAt, { dateStyle: 'medium', timeStyle: 'short' })
                  : t('resourceSite.neverValidated')
              }}
            </dd>
          </div>
        </dl>
        <div class="settings-card-footer integration-form-footer">
          <div class="settings-feedback integration-feedback">
            <p v-if="notice" class="error settings-message" role="alert">{{ notice }}</p>
            <p v-if="feedback" class="success settings-message" role="status" aria-live="polite">{{ feedback }}</p>
          </div>
          <SourceConfigurationActions
            :busy="busy"
            :can-save="
              configuration.credentialUpdateRequired
                ? Boolean(credential.trim())
                : configured || Boolean(credential.trim())
            "
          />
        </div>
      </form>
      <p v-if="busy" role="status">{{ t('resourceSite.working', { site: props.name }) }}</p>
    </template>
  </IntegrationCard>
</template>
