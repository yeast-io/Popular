<script setup lang="ts">
import type { IntegrationCategory, IntegrationPreferences } from '@movie-hub/contract';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import { localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';

const props = defineProps<{ id: string; category: IntegrationCategory; status: string; disabled?: boolean | undefined }>();
const { apiBaseUrl } = loadWebConfig();
const { t, locale } = useI18n();
const preferences = ref<IntegrationPreferences | null>(null);
const busy = ref(false);
const error = ref('');
const isDefault = computed(() => preferences.value?.defaults?.[props.category] === props.id);
async function load() {
  try {
    const response = await fetch(`${apiBaseUrl}/me/integration-preferences`, { credentials: 'include' });
    if (!response.ok) throw await localizedResponseError(response);
    preferences.value = await response.json();
    error.value = '';
  } catch (cause) { error.value = localizedErrorMessage(cause, 'errors.requestFailed'); }
}
async function setDefault() {
  busy.value = true;
  error.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/integration-preferences/default`, {
      method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json', 'accept-language': locale.value },
      body: JSON.stringify({ category: props.category, id: props.id }),
    });
    if (!response.ok) throw await localizedResponseError(response);
    preferences.value = await response.json();
    window.dispatchEvent(new Event('integration-preferences-changed'));
  } catch (cause) { error.value = localizedErrorMessage(cause, 'errors.requestFailed'); }
  finally { busy.value = false; }
}
onMounted(() => { void load(); window.addEventListener('integration-preferences-changed', load); });
onBeforeUnmount(() => window.removeEventListener('integration-preferences-changed', load));
watch(() => props.status, () => window.dispatchEvent(new Event('integration-preferences-changed')));
</script>
<template>
  <div class="integration-default-action">
    <span v-if="isDefault" class="integration-default-badge">{{ t('integrationDefaults.default') }}</span>
    <button v-else type="button" class="integration-default-badge integration-default-button" :disabled="busy || disabled || status !== 'configured_valid' || !preferences" @click="setDefault">
      {{ t('integrationDefaults.setDefault') }}
    </button>
    <span v-if="error" class="error" role="alert">{{ error }}</span>
  </div>
</template>
