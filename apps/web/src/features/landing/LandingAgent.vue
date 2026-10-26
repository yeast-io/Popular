<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '../../i18n';
import agentLogo from '../../assets/integrations/popular-link-agent.png';
import { getIntegrationLogo } from '../settings/integration-logos';
import { linkAgentMessages } from '../link-agent/link-agent.messages';

const { locale } = useI18n();
const copy = computed(() => linkAgentMessages[locale.value]);
defineEmits<{ open: [] }>();
</script>

<template>
  <aside class="la" aria-labelledby="la-title">
    <div class="la-copy"><p class="la-eyebrow">{{ copy.teaserEyebrow }}</p><h3 id="la-title">{{ copy.teaserTitle }}</h3><p>{{ copy.teaserText }}</p><a class="la-link" href="/link-agent" @click.prevent="$emit('open')">{{ copy.teaserButton }}<span aria-hidden="true">↗</span></a></div>
    <div class="la-visual" role="img" :aria-label="copy.connectionDiagram">
      <div class="la-sources la-node"><div class="la-logos"><img :src="getIntegrationLogo('mteam')" alt="M-Team" /><img :src="getIntegrationLogo('hdarea')" alt="HDArea" /><span class="la-more" :title="copy.future">···</span></div><small>{{ copy.source }}</small></div>
      <span class="la-source-edge la-edge" aria-hidden="true">←</span>
      <div class="la-website la-node"><span class="la-popular-mark" aria-hidden="true">p.</span><small>{{ copy.website }}</small></div>
      <span class="la-direct-edge la-edge" aria-hidden="true">→</span>
      <div class="la-online la-node"><div class="la-logos"><img :src="getIntegrationLogo('qbittorrent')" alt="qBittorrent" /><img :src="getIntegrationLogo('transmission')" alt="Transmission" /></div><small>{{ copy.onlineDownloader }}</small></div>
      <span class="la-branch la-edge" aria-hidden="true">↓</span>
      <div class="la-local-group"><span class="la-local-label">{{ copy.local }}</span><div class="la-agent la-node"><img class="la-agent-logo" :src="agentLogo" alt="Popular Link Agent" /><strong>PLA</strong></div><span class="la-local-edge la-edge" aria-hidden="true">→</span><div class="la-offline la-node"><div class="la-logos"><img :src="getIntegrationLogo('qbittorrent')" alt="qBittorrent" /><img :src="getIntegrationLogo('transmission')" alt="Transmission" /></div><small>{{ copy.downloader }}</small></div></div>
    </div>
  </aside>
</template>

<style scoped>
.la { display: grid; grid-template-columns: .8fr 1.2fr; align-items: center; gap: 38px; padding: 38px; margin-top: 42px; background: radial-gradient(ellipse at 85% 35%, #899d7110, transparent 60%); }
.la-eyebrow { font-size: 10px; color: #9daa95; letter-spacing: 1px; line-height: 1.8; margin: 0 0 16px; }
.la-copy h3 { font-size: 25px; line-height: 1.5; font-weight: 600; letter-spacing: -.6px; margin: 0 0 16px; }
.la-copy > p:not(.la-eyebrow) { color: #9fa99f; font-size: 12px; line-height: 1.9; margin: 0; }
.la-link { display: inline-flex; align-items: center; gap: 22px; margin-top: 25px; color: #e0e7d9; border-bottom: 1px solid #91a67b60; font-size: 12px; padding-bottom: 8px; }
.la-link:hover { color: var(--brand); }
.la-link:focus-visible { outline: 2px solid var(--brand); outline-offset: 5px; }
.la-visual { --la-edge-width: 25px; display: grid; grid-template-columns: minmax(0, 1fr) var(--la-edge-width) minmax(0, 1fr) var(--la-edge-width) minmax(0, 1fr); grid-template-rows: auto 40px auto; align-items: center; gap: 0 7px; min-width: 0; }
.la-node { min-width: 0; text-align: center; }
.la-node small { display: block; color: #a7b39d; font-size: 9px; line-height: 1.6; margin-top: 14px; }
.la-sources { grid-column: 1; grid-row: 1; }
.la-source-edge { grid-column: 2; grid-row: 1; }
.la-website { grid-column: 3; grid-row: 1; }
.la-direct-edge { grid-column: 4; grid-row: 1; }
.la-online { grid-column: 5; grid-row: 1; }
.la-popular-mark { display: block; font-size: 48px; color: var(--brand); font-weight: 800; letter-spacing: -5px; line-height: 1; }
.la-logos { min-height: 48px; display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 9px; }
.la-logos img { width: 24px; height: 24px; object-fit: contain; }
.la-more { display: grid; place-items: center; width: 22px; height: 22px; border: 1px dashed #ffffff30; border-radius: 50%; font-size: 14px; color: #94a286; }
.la-edge { color: #bb855b; text-align: center; font-size: 21px; line-height: 1; }
.la-branch { grid-column: 3; grid-row: 2; align-self: stretch; display: grid; place-items: center; position: relative; }
.la-branch::before { content: ''; position: absolute; width: 1px; height: 100%; background: linear-gradient(#b17b5630, #b17b56a0); }
.la-branch { color: #cb9d75; }
.la-local-group { position: relative; grid-column: 3 / 6; grid-row: 3; display: grid; grid-template-columns: minmax(0, 1fr) var(--la-edge-width) minmax(0, 1fr); gap: 7px; align-items: center; border: 1px solid #9bae7f30; border-radius: 9px; padding-block: 25px 18px; background: #91a76f07; }
.la-local-label { position: absolute; left: 12px; top: -8px; background: #151912; color: #a3b494; font-size: 9px; padding-inline: 6px; }
.la-agent-logo { width: 48px; height: 48px; object-fit: contain; }
.la-agent strong { display: block; font-size: 11px; margin-top: 10px; font-weight: 500; color: #dce4d3; }
.la-offline .la-logos { min-height: 48px; }
@media (max-width: 1050px) { .la { grid-template-columns: 1fr; gap: 35px; padding: 30px; } .la-visual { width: min(600px, 100%); margin-inline: auto; } }
@media (max-width: 480px) { .la { padding: 24px 16px; } .la-copy h3 { font-size: 22px; } .la-visual { --la-edge-width: 16px; gap: 0 4px; } .la-logos { gap: 6px; } .la-logos img { width: 21px; height: 21px; } .la-more { width: 18px; height: 18px; } .la-local-group { gap: 4px; } .la-node small { font-size: 8px; } .la-popular-mark { font-size: 42px; } }
</style>
