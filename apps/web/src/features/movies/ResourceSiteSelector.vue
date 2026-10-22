<script setup lang="ts">
import type { IntegrationPreferences, MovieResourceCheckResponse } from '@movie-hub/contract';
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { resourceSiteIconStyle } from './resource-site.presentation';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import { localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';

const props = defineProps<{ disabled?: boolean | undefined; check?: MovieResourceCheckResponse | null }>();
const emit = defineEmits<{ loaded: [preferences: IntegrationPreferences]; changed: [preferences: IntegrationPreferences] }>();
const { apiBaseUrl } = loadWebConfig();
const { t, locale, formatDate } = useI18n();
const tooltipPrefix = useId();
const preferences = ref<IntegrationPreferences | null>(null);
const saving = ref(false);
const error = ref('');
const sources = computed(() => preferences.value?.choices.filter((choice) => choice.category === 'resource') ?? []);
function sourceCheck(id: string) {
  return props.check?.sources?.find((source) => source.provider === id)
    ?? (props.check?.provider === id ? props.check : undefined);
}
function available(id: string) {
  return sourceCheck(id)?.availability === 'available';
}
function statusLabel(id: string) {
  const source = sources.value.find((choice) => choice.id === id);
  if (source?.status === 'unconfigured') return t('resourceSelection.unconfigured');
  if (source?.status === 'configured_invalid') return t('resourceSelection.invalid');
  const check = sourceCheck(id);
  if (check?.checking) return t('movie.resource.checking');
  if (check?.lastAttemptStatus === 'error') return t(available(id)
    ? 'movie.resource.availableRefreshFailed'
    : 'movie.resource.checkFailed');
  if (available(id)) return t('resourceSelection.available');
  if (check?.availability === 'unavailable') return t('movie.resource.unavailable');
  if (check?.availability === 'unmatchable') return t('movie.resource.unmatchable');
  return t('movie.resource.pending');
}
function tooltip(id: string, name: string) {
  const checkedAt = sourceCheck(id)?.checkedAt;
  return [name, statusLabel(id), checkedAt
    ? t('resourceSelection.queriedAt', {
        date: formatDate(checkedAt, { dateStyle: 'short', timeStyle: 'short' }),
      })
    : ''].filter(Boolean).join(' · ');
}
let generation = 0;
async function load() {
  const current = ++generation;
  try {
    const response = await fetch(`${apiBaseUrl}/me/integration-preferences`, { credentials: 'include' });
    if (!response.ok) throw await localizedResponseError(response);
    const body = await response.json() as IntegrationPreferences;
    if (!body.defaults || !Array.isArray(body.choices) || !Array.isArray(body.effectiveSites) || !Array.isArray(body.selectedSites)) throw new Error('Invalid integration preferences');
    if (current !== generation) return;
    preferences.value = body;
    emit('loaded', body);
  } catch (cause) { if (current === generation) error.value = localizedErrorMessage(cause, 'errors.requestFailed'); }
}
async function select(sites: string[]) {
  if (saving.value || props.disabled) return;
  saving.value = true;
  error.value = '';
  ++generation;
  try {
    const response = await fetch(`${apiBaseUrl}/me/integration-preferences/resource-sites`, {
      method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json', 'accept-language': locale.value }, body: JSON.stringify({ sites }),
    });
    if (!response.ok) throw await localizedResponseError(response);
    preferences.value = await response.json() as IntegrationPreferences;
    emit('changed', preferences.value);
  } catch (cause) { error.value = localizedErrorMessage(cause, 'errors.requestFailed'); } finally {
    saving.value = false;
  }
}
function toggle(id: string) {
  const checked = !preferences.value?.effectiveSites.includes(id);
  const sites = preferences.value?.effectiveSites ?? [];
  void select(checked ? [...new Set([...sites, id])] : sites.filter((site) => site !== id));
}
onMounted(() => {
  void load();
});
onBeforeUnmount(() => {
  ++generation;
});
</script>
<template>
  <div class="resource-site-selector">
    <fieldset class="resource-site-options" :disabled="disabled || saving || !preferences">
      <legend class="sr-only">{{ t('resourceSelection.title') }}</legend>
      <div class="resource-site-icons">
        <div v-for="source in sources" :key="source.id" class="resource-site-tile" :title="tooltip(source.id, source.name)">
          <button
            type="button" class="resource-site-toggle"
            :class="{ 'is-selected': preferences?.effectiveSites.includes(source.id) }"
            :style="resourceSiteIconStyle(source.id)"
            :aria-label="t('resourceSelection.selectSite', { name: source.name })"
            :aria-pressed="preferences?.effectiveSites.includes(source.id) ?? false"
            :aria-describedby="`${tooltipPrefix}-${source.id}`"
            :disabled="source.status === 'unconfigured'"
            @click="toggle(source.id)"
          >
            <span class="resource-site-outline" aria-hidden="true" />
          </button>
          <span :id="`${tooltipPrefix}-${source.id}`" role="tooltip" class="resource-site-tooltip">{{ tooltip(source.id, source.name) }}</span>
        </div>
      </div>
      <slot name="actions" />
    </fieldset>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </div>
</template>
