<script setup lang="ts">
import { computed } from 'vue';
import { useAgentContext } from '../../agent-context.composable';
import AgentIcon from '../../components/AgentIcon.vue';
import StatusPill from '../../components/StatusPill.vue';
import qbittorrentIcon from '../../assets/qbittorrent.svg';
import transmissionIcon from '../../assets/transmission.svg';

const {
  t,
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
const ready = computed(
  () =>
    !runtimeFailed.value
    && form.downloaderConfigured
    && runtime.value.service === 'online'
    && runtime.value.downloader === 'online'
);
const gatewayOnline = computed(() => !runtimeFailed.value && runtime.value.service === 'online');
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
        {{
          runtimeFailed
            ? t.statusUnknown
            : ready
              ? t.agentReady
              : gatewayOnline
                ? t.agentNeedsDownloader
                : t.agentNeedsSetup
        }}
      </h2>
      <p>
        {{
          runtimeFailed
            ? t.runtimeUnavailableDescription
            : ready
              ? t.readyDescription
              : gatewayOnline
                ? t.needsDownloaderDescription
                : t.setupDescription
        }}
      </p>
    </div>
  </section>
  <div class="connection-grid">
    <article class="connection-card">
      <div class="card-top">
        <div class="connection-title">
          <AgentIcon name="link" />
          <h3>{{ t.popularConnection }}</h3>
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
            v-if="form.downloaderConfigured"
            class="tool-icon"
            :src="savedProvider === 'qbittorrent' ? qbittorrentIcon : transmissionIcon"
            alt=""
          />
          <AgentIcon v-else name="downloaders" />
          <h3>
            {{
              form.downloaderConfigured
                ? t[savedProvider === 'qbittorrent' ? 'qbittorrentName' : 'transmissionName']
                : t.localDownloadTool
            }}
          </h3>
        </div>
        <StatusPill :status="observed(form.downloaderConfigured ? runtime.downloader : 'unconfigured')" />
      </div>
      <p class="endpoint">{{ form.downloaderConfigured ? savedDownloaderUrl : t.unconfigured }}</p>
      <button class="text-action" type="button" @click="navigate('downloaders')">
        {{ t.manageDownloader }}<AgentIcon name="arrow" />
      </button>
    </article>
  </div>
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
