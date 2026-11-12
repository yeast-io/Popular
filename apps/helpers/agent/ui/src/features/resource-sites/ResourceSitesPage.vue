<script setup lang="ts">
import { onMounted } from 'vue';
import { useAgentContext } from '../../agent-context.composable';
import AgentIcon from '../../components/AgentIcon.vue';
import CapsuleSwitch from '../../components/CapsuleSwitch.vue';
import SecretInput from '../../components/SecretInput.vue';
import { resourceSitePreviews, siteNames, hdareaApiAddress } from './resource-sites.presentation';
import { canConfigureSite, sameSiteEndpoint } from './resource-sites.domain';

const { t, text, sites, form } = useAgentContext();
const { entries, loading, loaded, error, available, load, configure, toggle, setDefault, canSetDefault } = sites;
onMounted(() => {
  if (available && !loaded.value && !error.value) void load();
});
</script>
<template>
  <template v-if="!available">
    <section class="empty-feature">
      <span class="empty-feature-icon"><AgentIcon name="resource-sites" /></span>
      <h2>{{ t.sitesNotAvailableTitle }}</h2>
      <p>{{ t.sitesNotAvailableDescription }}</p>
    </section>
    <div class="site-preview-grid">
      <article v-for="site in resourceSitePreviews" :key="site" class="site-preview">
        <span class="site-initial">{{ site.slice(0, 1) }}</span>
        <div>
          <h3>{{ site }}</h3>
          <p>{{ t.noSiteCredentials }}</p>
        </div>
      </article>
    </div>
  </template>
  <template v-else>
    <p class="notice local-sites-scope" role="note">{{ t.localSitesScope }}</p>
    <p v-if="loading" role="status">{{ t.loadingSettings }}</p>
    <section v-if="error" class="load-failure" role="alert">
      <p>{{ text(error) }}</p>
      <button type="button" :disabled="loading" @click="load">{{ t.retry }}</button>
    </section>
    <div class="local-sites-grid" :aria-busy="loading">
      <article
        v-for="entry in entries"
        :key="entry.snapshot.site"
        class="local-site-card"
        :data-site="entry.snapshot.site"
      >
        <header class="local-site-header">
          <div class="local-site-identity">
            <span class="site-initial">{{ siteNames[entry.snapshot.site].slice(0, 1) }}</span>
            <div>
              <h2>{{ siteNames[entry.snapshot.site] }}</h2>
              <p>{{ t.localCredentials }}</p>
            </div>
          </div>
          <div v-if="entry.snapshot.status !== 'unconfigured'" class="local-site-controls">
            <CapsuleSwitch
              :checked="entry.snapshot.enabled"
              :label="entry.snapshot.enabled ? t.siteEnabled : t.siteDisabled"
              :disabled="entry.busy || (!entry.snapshot.enabled && entry.snapshot.status === 'configured_invalid')"
              @change="toggle(entry)"
            />
            <label v-if="canSetDefault" class="site-default-choice">
              <input
                type="radio"
                name="default-resource-site"
                :value="entry.snapshot.site"
                :checked="entry.snapshot.isDefault"
                :disabled="entry.busy || !entry.snapshot.enabled || entry.snapshot.status !== 'configured_valid'"
                @change="setDefault(entry)"
              />
              {{ t.defaultItem }}
            </label>
          </div>
        </header>
        <span class="pill" :class="entry.snapshot.status === 'configured_invalid' ? 'warning' : 'neutral'">
          <span
            class="status-dot"
            :class="{
              online: entry.snapshot.status === 'configured_valid' && entry.snapshot.enabled,
              failed: entry.snapshot.status === 'configured_invalid',
              unconfigured: entry.snapshot.status === 'unconfigured',
            }"
          />{{
            entry.snapshot.status === 'unconfigured'
              ? t.unconfigured
              : entry.snapshot.status === 'configured_invalid'
                ? t.siteInvalid
                : t.siteConfigured
          }}</span
        >
        <p v-if="entry.error" class="error" role="alert">{{ text(entry.error) }}</p>
        <p v-else-if="entry.snapshot.lastError" class="error" role="status">{{ text(entry.snapshot.lastError) }}</p>
        <form novalidate @submit.prevent="configure(entry)">
          <label v-if="entry.snapshot.site === 'hdarea'" :for="`${entry.snapshot.site}-api-url`">
            {{ t.siteApiAddress }}
            <input
              :id="`${entry.snapshot.site}-api-url`"
              :value="hdareaApiAddress(entry.baseUrl)"
              type="url"
              readonly
              autocomplete="url"
            />
          </label>
          <label :for="`${entry.snapshot.site}-base-url`">
            {{ entry.snapshot.site === 'mteam' ? t.siteApiAddress : t.siteWebAddress }}
            <input
              :id="`${entry.snapshot.site}-base-url`"
              v-model="entry.baseUrl"
              type="url"
              maxlength="2048"
              :disabled="entry.busy"
              required
              autocomplete="url"
            />
          </label>
          <p class="field-note">{{ t.siteEndpointHint }}</p>
          <label
            >{{ entry.snapshot.site !== 'hdwing' ? t.siteApiKey : t.siteCookie
            }}<SecretInput
              :id="`${entry.snapshot.site}-${entry.snapshot.site === 'hdwing' ? 'cookie' : 'api-key'}`"
              v-model="entry.credential"
              :saved="sameSiteEndpoint(entry) && entry.snapshot.hasCredential"
              :maxlength="entry.snapshot.site === 'hdarea' ? 32 : entry.snapshot.site === 'mteam' ? 4096 : 8192"
              :disabled="entry.busy"
          /></label>

          <p v-if="entry.snapshot.site === 'hdarea'" class="field-note">{{ t.hdareaApiKeyHint }}</p>
          <p v-if="entry.snapshot.verifiedAt" class="field-note">
            {{ t.siteVerifiedAt }}: {{ new Date(entry.snapshot.verifiedAt).toLocaleString(form.locale) }}
          </p>
          <div class="site-form-footer">
            <p v-if="entry.saved" class="success" role="status" aria-live="polite">{{ t.siteSaved }}</p>
            <button class="primary" type="submit" :disabled="!canConfigureSite(entry)">
              {{ entry.busy ? t.siteTesting : t.siteVerifySave }}
            </button>
          </div>
        </form>
      </article>
    </div>
  </template>
</template>

<style scoped>
.site-default-choice {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  white-space: nowrap;
}
.site-default-choice input {
  width: 14px;
  height: 14px;
  margin: 0;
  padding: 0;
  accent-color: var(--accent);
}
.site-form-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 12px;
}
.site-form-footer .success {
  margin: 0 auto 0 0;
}
</style>
