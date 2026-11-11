<script setup lang="ts">
import { onMounted } from 'vue';
import { useAgentContext } from '../../agent-context.composable';
import AgentIcon from '../../components/AgentIcon.vue';
import SecretInput from '../../components/SecretInput.vue';
import { resourceSitePreviews, siteNames } from './resource-sites.presentation';
import { canConfigureSite, sameSiteEndpoint } from './resource-sites.domain';

const { t, text, sites, form } = useAgentContext();
const { entries, loading, loaded, error, available, load, configure, cancel, remove, verify, toggle } = sites;
onMounted(() => {
  if (available && !loaded.value) void load();
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
          <span class="site-initial">{{ siteNames[entry.snapshot.site].slice(0, 1) }}</span>
          <div>
            <h2>{{ siteNames[entry.snapshot.site] }}</h2>
            <p>{{ t.localCredentials }}</p>
          </div>
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
                  : entry.snapshot.enabled
                    ? t.siteEnabled
                    : t.siteDisabled
            }}</span
          >
        </header>
        <p v-if="entry.error" class="error" role="alert">{{ text(entry.error) }}</p>
        <p v-else-if="entry.snapshot.lastError" class="error" role="status">{{ text(entry.snapshot.lastError) }}</p>
        <form v-if="entry.editing" @submit.prevent="configure(entry)">
          <label
            >{{ t.siteBaseUrl
            }}<input
              v-model="entry.baseUrl"
              type="url"
              maxlength="2048"
              :disabled="entry.busy"
              required
              autocomplete="off"
          /></label>
          <p class="field-note">{{ t.siteEndpointHint }}</p>
          <label
            >{{ entry.snapshot.site === 'mteam' ? t.siteApiKey : t.siteCookie
            }}<SecretInput
              v-model="entry.credential"
              :saved="sameSiteEndpoint(entry) && entry.snapshot.hasCredential"
              :maxlength="entry.snapshot.site === 'mteam' ? 4096 : 8192"
              :disabled="entry.busy"
          /></label>

          <div class="summary-actions">
            <button class="primary" type="submit" :disabled="!canConfigureSite(entry)">
              {{ entry.busy ? t.busy : t.siteVerifySave }}</button
            ><button
              v-if="entry.snapshot.status !== 'unconfigured'"
              type="button"
              :disabled="entry.busy"
              @click="cancel(entry)"
            >
              {{ t.cancel }}
            </button>
          </div>
        </form>
        <div v-else class="local-site-summary">
          <p class="endpoint">{{ entry.snapshot.baseUrl }}</p>
          <p class="field-note">
            {{ t.siteVerifiedAt }}:
            {{
              entry.snapshot.verifiedAt
                ? new Date(entry.snapshot.verifiedAt).toLocaleString(form.locale)
                : t.siteNeverVerified
            }}
          </p>
          <div class="summary-actions">
            <button
              type="button"
              :disabled="entry.busy"
              @click="
                entry.editing = true;
                entry.error = '';
              "
            >
              {{ t.editConfig }}</button
            ><button type="button" :disabled="entry.busy" @click="verify(entry)">{{ t.siteVerify }}</button
            ><button
              type="button"
              :disabled="entry.busy || (!entry.snapshot.enabled && entry.snapshot.status === 'configured_invalid')"
              @click="toggle(entry)"
            >
              {{ entry.snapshot.enabled ? t.siteDisable : t.siteEnable }}
            </button>
          </div>
        </div>
        <div v-if="entry.snapshot.status !== 'unconfigured'" class="local-site-delete">
          <template v-if="entry.confirmingDelete"
            ><p>{{ t.siteDeleteConfirm }}</p>
            <button type="button" class="danger" :disabled="entry.busy" @click="remove(entry)">
              {{ t.siteDelete }}</button
            ><button type="button" :disabled="entry.busy" @click="entry.confirmingDelete = false">
              {{ t.cancel }}
            </button></template
          >
          <button
            v-else
            type="button"
            class="text-action"
            :disabled="entry.busy"
            @click="entry.confirmingDelete = true"
          >
            {{ t.siteDelete }}
          </button>
        </div>
      </article>
    </div>
  </template>
</template>
