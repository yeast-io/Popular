<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useAgentContext } from '../../agent-context.composable';
import AgentIcon from '../../components/AgentIcon.vue';
import StatusPill from '../../components/StatusPill.vue';
import qbittorrentIcon from '../../assets/qbittorrent.svg';
import transmissionIcon from '../../assets/transmission.svg';
import { siteNames } from '../resource-sites/resource-sites.presentation';

const {
  t,
  text,
  sites,
  profiles,
  runtime,
  runtimeFailed,
  lastRuntimeAt,
  savedGateway,
  savedDownloaderUrl,
  savedProvider,
  gatewayConfigured,
  form,
  navigate,
} = useAgentContext();
const defaultDownloader = computed(() => profiles.entries.value.find((row) => row.isDefault));
const downloaderPresent = computed(() => !!defaultDownloader.value || form.downloaderConfigured);
const ready = computed(
  () =>
    !runtimeFailed.value
    && form.downloaderConfigured
    && runtime.value.service === 'online'
    && runtime.value.downloader === 'online'
);
const gatewayOnline = computed(() => !runtimeFailed.value && runtime.value.service === 'online');
const heroLabels = computed(() => {
  if (runtimeFailed.value) return { title: 'statusUnknown', description: 'runtimeUnavailableDescription' } as const;
  if (ready.value) return { title: 'agentReady', description: 'readyDescription' } as const;
  if (gatewayOnline.value) return { title: 'agentNeedsDownloader', description: 'needsDownloaderDescription' } as const;
  return { title: 'agentNeedsSetup', description: 'setupDescription' } as const;
});
onMounted(() => {
  if (sites.available && !sites.loaded.value && !sites.error.value) void sites.load();
});
function observed(status: string) {
  return runtimeFailed.value ? 'statusUnknown' : !lastRuntimeAt.value ? 'checkingStatus' : status;
}
</script>
<template>
  <section class="overview-hero" :class="{ ready }">
    <div class="hero-symbol"><AgentIcon :name="ready ? 'check' : 'link'" /></div>
    <div>
      <p class="eyebrow">{{ t.connectionHealth }}</p>
      <h2>
        {{ t[heroLabels.title] }}
      </h2>
      <p>
        {{ t[heroLabels.description] }}
      </p>
    </div>
  </section>
  <div class="connection-grid">
    <article class="connection-card">
      <div class="card-top">
        <div class="connection-title">
          <AgentIcon name="link" />
          <h3>{{ t.gatewayConnection }}</h3>
        </div>
        <StatusPill :status="observed(runtime.service)" />
      </div>
      <p class="endpoint">{{ savedGateway || t.unconfigured }}</p>
      <button class="text-action" type="button" @click="navigate('settings')">
        {{ t.manageConnection }}<AgentIcon name="arrow" />
      </button>
    </article>
    <article class="connection-card">
      <div class="card-top">
        <div class="connection-title">
          <img
            v-if="downloaderPresent"
            class="tool-icon"
            :src="savedProvider === 'qbittorrent' ? qbittorrentIcon : transmissionIcon"
            alt=""
          />
          <AgentIcon v-else name="downloaders" />
          <h3>
            {{
              downloaderPresent
                ? t[savedProvider === 'qbittorrent' ? 'qbittorrentName' : 'transmissionName']
                : t.localDownloadTool
            }}
          </h3>
        </div>
        <StatusPill :status="defaultDownloader && !defaultDownloader.enabled ? 'siteDisabled' : observed(form.downloaderConfigured ? runtime.downloader : 'unconfigured')" />
      </div>
      <p class="endpoint">{{ downloaderPresent ? savedDownloaderUrl : t.unconfigured }}</p>
      <button class="text-action" type="button" @click="navigate('downloaders')">
        {{ t.manageDownloader }}<AgentIcon name="arrow" />
      </button>
    </article>
  </div>
  <section class="settings-panel">
    <div class="panel-heading">
      <h2>{{ t.navResourceSites }}</h2>
      <button type="button" class="quiet" @click="navigate('resource-sites')">
        {{ t.navResourceSites }}<AgentIcon name="arrow" />
      </button>
    </div>
    <p v-if="!sites.available">{{ t.sitesNotAvailableDescription }}</p>
    <template v-else>
      <p v-if="sites.loading.value" role="status">{{ t.checkingStatus }}</p>
      <div v-if="sites.error.value" class="error" role="alert">
        {{ text(sites.error.value) }}
        <button type="button" :disabled="sites.loading.value || sites.dirty.value" @click="sites.load">
          {{ t.retry }}
        </button>
      </div>
      <dl v-if="!sites.error.value && sites.loaded.value" class="diagnostic-list">
        <div v-for="entry in sites.entries" :key="entry.snapshot.site">
          <dt>{{ siteNames[entry.snapshot.site] }} <span v-if="entry.snapshot.isDefault" class="pill neutral">{{ t.defaultItem }}</span></dt>
          <dd>
            <span
              class="pill"
              :class="entry.snapshot.status === 'configured_invalid' ? 'warning' : 'neutral'"
              role="status"
            >
              <span
                class="status-dot"
                :class="{ online: entry.snapshot.status === 'configured_valid' && entry.snapshot.enabled }"
              />
              <template v-if="entry.snapshot.status === 'unconfigured'">{{ t.unconfigured }}</template>
              <template v-else-if="entry.snapshot.status === 'configured_invalid'">{{ t.siteInvalid }}</template>
              <template v-else>{{ entry.snapshot.enabled ? t.siteEnabled : t.siteDisabled }}</template>
            </span>
            <p v-if="entry.snapshot.lastError" class="error">{{ text(entry.snapshot.lastError) }}</p>
          </dd>
        </div>
      </dl>
    </template>
  </section>
  <section v-if="!gatewayConfigured || !form.downloaderConfigured" class="setup-panel">
    <h2>{{ t.nextSteps }}</h2>
    <button v-if="!gatewayConfigured" type="button" class="setup-row" @click="navigate('settings')">
      <span class="step-number">01</span
      ><span
        ><strong>{{ t.stepGateway }}</strong
        ><small>{{ t.stepGatewayDescription }}</small></span
      ><AgentIcon name="arrow" /></button
    ><button v-if="!form.downloaderConfigured" type="button" class="setup-row" @click="navigate('downloaders')">
      <span class="step-number">02</span
      ><span
        ><strong>{{ t.stepDownloader }}</strong
        ><small>{{ t.stepDownloaderDescription }}</small></span
      ><AgentIcon name="arrow" />
    </button>
  </section>
  <section class="queue-shortcut">
    <span class="feature-icon"><AgentIcon name="tasks" /></span>
    <div>
      <h3>{{ t.pendingRequests }}</h3>
      <p>{{ t.pendingRequestsDescription }}</p>
    </div>
    <button type="button" @click="navigate('tasks')">{{ t.viewTasks }}<AgentIcon name="arrow" /></button>
  </section>
  <aside class="privacy-note">
    <AgentIcon name="shield" />
    <div>
      <strong>{{ t.localBoundaryTitle }}</strong>
      <p>{{ t.localBoundaryDescription }}</p>
    </div>
  </aside>
</template>
