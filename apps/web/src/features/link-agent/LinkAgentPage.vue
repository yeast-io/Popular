<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '../../i18n';
import BrandLogo from '../branding/BrandLogo.vue';
import { getIntegrationLogo } from '../settings/integration-logos';
import agentLogo from '../../assets/integrations/popular-link-agent.png';
import { linkAgentMessages } from './link-agent.messages';

const { locale, setLocale } = useI18n();
const copy = computed(() => linkAgentMessages[locale.value]);
defineEmits<{ home: []; login: [] }>();
</script>

<template>
  <div class="agent-page">
    <header class="agent-header site-header-glass">
      <a href="/" class="agent-brand" aria-label="Popular" @click.prevent="$emit('home')"><BrandLogo /></a>
      <div class="agent-header-actions"><button class="agent-language" type="button" :aria-label="copy.language" @click="setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN')">{{ locale === 'zh-CN' ? 'EN' : '中文' }}</button><button class="agent-signin" type="button" @click="$emit('login')">{{ copy.login }}<span aria-hidden="true">↗</span></button></div>
    </header>

    <section class="agent-hero agent-container">
      <div><a class="agent-back" href="/" @click.prevent="$emit('home')"><span aria-hidden="true">←</span>{{ copy.back }}</a><p class="agent-eyebrow">{{ copy.eyebrow }}</p><h1>{{ copy.title }}<br /><em>{{ copy.accent }}</em></h1><p class="agent-intro">{{ copy.intro }}</p><a class="agent-button" href="#agent-setup">{{ copy.setup }}<span aria-hidden="true">↓</span></a><p class="agent-note">{{ copy.heroNote }}</p></div>
      <div class="agent-hero-art">
        <div class="agent-halo" aria-hidden="true"></div>
        <div class="agent-window">
          <div class="agent-window-bar"><span class="agent-window-dots" aria-hidden="true">● ● ●</span><span>{{ copy.windowTitle }}</span></div>
          <div class="agent-device-title"><img :src="agentLogo" alt="Popular Link Agent" /><div><strong>Popular Link Agent</strong><span>{{ copy.device }}</span></div><span class="agent-online">{{ copy.online }}</span></div>
          <div class="agent-status-row"><span>{{ copy.service }}</span><strong><i></i>{{ copy.bound }}</strong></div>
          <div class="agent-status-row"><span>{{ copy.downloader }}</span><strong><i></i>{{ copy.online }}</strong></div>
          <div class="agent-task"><div><span>{{ copy.progress }}</span><small>{{ copy.syncing }}</small></div><strong>{{ copy.film }}</strong><div class="agent-progress"><span></span></div><span class="agent-percent">{{ copy.percentage }}</span></div>
          <p class="agent-illustration">{{ copy.illustration }}</p>
        </div>
        <div class="agent-floating"><span aria-hidden="true">↗</span>{{ copy.website }}<span class="agent-floating-dot" aria-hidden="true"></span></div>
      </div>
    </section>

    <section class="agent-architecture agent-container" aria-labelledby="agent-architecture-title">
      <p class="agent-eyebrow">{{ copy.bridgeEyebrow }}</p><h2 id="agent-architecture-title">{{ copy.bridgeTitle }}</h2><p class="agent-section-intro">{{ copy.bridgeIntro }}</p>
      <div class="agent-network">
        <div class="agent-web-node"><div class="agent-source-logos"><img v-for="site in ['mteam', 'hdarea']" :key="site" :src="getIntegrationLogo(site)" :alt="site === 'mteam' ? 'M-Team' : 'HDArea'" /><span :aria-label="copy.future">···</span></div><span class="agent-source-label">{{ copy.source }}</span><span class="agent-network-up" aria-hidden="true">↑</span><div class="agent-popular-mark" aria-hidden="true">p.</div><h3>{{ copy.website }}</h3><p>{{ copy.websiteText }}</p></div>
        <div class="agent-connection" aria-hidden="true"><span></span><b>↔</b></div>
        <div class="agent-gateway"><span aria-hidden="true">⌘</span><h3>{{ copy.gateway }}</h3><p>{{ copy.gatewayText }}</p></div>
        <div class="agent-connection" aria-hidden="true"><span></span><b>↔</b></div>
        <div class="agent-local-node"><span class="agent-local-label">{{ copy.local }}</span><img class="agent-node-logo" :src="agentLogo" alt="Popular Link Agent" /><h3>{{ copy.agent }}</h3><p>{{ copy.agentText }}</p><span class="agent-network-down" aria-hidden="true">↓</span><div class="agent-downloader-logos"><img :src="getIntegrationLogo('qbittorrent')" alt="qBittorrent" /><img :src="getIntegrationLogo('transmission')" alt="Transmission" /><span>{{ copy.downloader }}</span></div></div>
      </div>
      <div class="agent-capabilities"><article v-for="(item, index) in copy.capabilities" :key="item.title"><span>0{{ index + 1 }}</span><h3>{{ item.title }}</h3><p>{{ item.text }}</p></article></div>
    </section>

    <section id="agent-setup" class="agent-setup">
      <div class="agent-container"><p class="agent-eyebrow">{{ copy.stepsEyebrow }}</p><h2>{{ copy.stepsTitle }}</h2>
        <div class="agent-setup-layout"><ol class="agent-steps"><li v-for="(item, index) in copy.steps" :key="item.title"><span>0{{ index + 1 }}</span><div><h3>{{ item.title }}</h3><p>{{ item.text }}</p></div></li></ol>
          <div class="agent-config-window"><div class="agent-config-heading"><img :src="agentLogo" alt="" /><strong>{{ copy.configTitle }}</strong><span class="agent-window-dots" aria-hidden="true">● ● ●</span></div>
            <div class="agent-config-group"><h3>{{ copy.connection }}<span>{{ copy.bound }}</span></h3><div class="agent-config-field"><span>{{ copy.gatewayAddress }}</span><div>{{ copy.urlExample }}</div></div><div class="agent-config-field"><span>{{ copy.key }}</span><div>{{ copy.keyExample }}<small>{{ copy.configured }}</small></div></div></div>
            <div class="agent-config-group"><h3>{{ copy.downloader }}<span>{{ copy.online }}</span></h3><span class="agent-config-label">{{ copy.provider }}</span><div class="agent-config-providers"><span v-for="provider in ['qbittorrent', 'transmission']" :key="provider"><img :src="getIntegrationLogo(provider)" :alt="provider" /></span></div><div class="agent-config-field"><span>{{ copy.address }}</span><div>{{ copy.localExample }}</div></div></div><p class="agent-illustration">{{ copy.illustration }}</p>
          </div>
        </div>
      </div>
    </section>

    <section class="agent-conditions agent-container"><h2>{{ copy.conditionsTitle }}</h2><div><article v-for="item in copy.conditions" :key="item.title"><h3>{{ item.title }}</h3><p>{{ item.text }}</p></article></div></section>
    <section class="agent-closing"><div class="agent-container"><img :src="agentLogo" alt="" /><div><h2>{{ copy.closingTitle }}</h2><p>{{ copy.closingText }}</p></div><button type="button" class="agent-button" @click="$emit('login')">{{ copy.closingButton }}<span aria-hidden="true">↗</span></button></div></section>
    <footer class="agent-footer agent-container"><a href="/" @click.prevent="$emit('home')"><BrandLogo /></a><span>{{ copy.footer }}</span></footer>
  </div>
</template>

<style scoped>
.agent-page { color: #f0ede5; overflow: clip; }
.agent-container { width: min(1200px, calc(100% - 96px)); margin-inline: auto; }
.agent-header { position: sticky; top: 0; z-index: 10; width: 100%; padding: 18px 24px; display: flex; align-items: center; justify-content: space-between; gap: 28px; border-bottom: 1px solid var(--line); }
.agent-brand { display: inline-flex; align-items: center; }
.agent-header-actions { display: flex; align-items: center; gap: 30px; }
.agent-language { border: 0; background: transparent; color: #b8b8b6; font-size: 12px; padding: 10px 0; }
.agent-signin { border: 1px solid #414243; padding: 7px 14px; color: #ccc; background: transparent; border-radius: 999px; font-size: .78rem; font-weight: 700; }
.agent-signin span { margin-left: 16px; }
.agent-hero { display: grid; grid-template-columns: 1.1fr 1fr; gap: 80px; align-items: center; padding-block: 50px 110px; min-height: 720px; }
.agent-back { display: inline-flex; gap: 10px; color: #8f9495; font-size: 11px; margin-bottom: 46px; }
.agent-eyebrow { font-size: 10px; color: #a9aea7; letter-spacing: 1.8px; margin: 0 0 24px; line-height: 1.8; }
.agent-hero h1 { font-size: clamp(40px, 4.2vw, 62px); letter-spacing: -2px; line-height: 1.3; margin: 0; }
.agent-hero h1 em { font-style: normal; color: var(--brand); }
.agent-intro { font-size: 14px; line-height: 1.95; color: #b4b9b6; max-width: 470px; margin: 28px 0; }
.agent-button { display: inline-flex; align-items: center; justify-content: center; gap: 24px; color: #181b17; background: var(--brand); border: 0; border-radius: 6px; padding: 17px 22px; font-size: 12px; font-weight: 700; }
.agent-button:hover { background: #ff734b; }
.agent-note { margin: 21px 0 0; color: #888f8c; font-size: 10px; line-height: 1.8; }
.agent-hero-art { position: relative; isolation: isolate; min-width: 0; }
.agent-halo { position: absolute; width: 470px; height: 470px; border: 1px solid #f0522d30; border-radius: 50%; top: -30px; left: -20px; box-shadow: 0 0 0 35px #f0522d04, 0 0 0 70px #f0522d03; }
.agent-window { position: relative; padding: 21px 25px; background: linear-gradient(135deg, #202623, #12191a); border: 1px solid #ffffff22; border-radius: 13px; transform: rotate(-3deg); box-shadow: 0 25px 70px #0008; }
.agent-window-bar { display: flex; justify-content: space-between; align-items: center; color: #8b9791; font-size: 10px; }
.agent-window-dots { font-size: 9px; color: #6a7770; letter-spacing: 3px; }
.agent-device-title { display: flex; align-items: center; gap: 13px; margin: 32px 0; }
.agent-device-title > img { width: 64px; height: 64px; object-fit: contain; }
.agent-device-title strong { display: block; font-size: 16px; }
.agent-device-title div > span { display: block; color: #8f9b95; font-size: 11px; margin-top: 8px; }
.agent-online { color: #b5d1bd; font-size: 9px; background: #6caa8620; border: 1px solid #8fb89a25; border-radius: 20px; padding: 6px 9px; margin-left: auto; white-space: nowrap; }
.agent-status-row { display: flex; justify-content: space-between; gap: 10px; padding: 17px 0; border-top: 1px solid #ffffff12; font-size: 11px; color: #a0ada4; }
.agent-status-row strong { display: flex; gap: 7px; align-items: center; color: #c1d7c8; font-weight: 400; }
.agent-status-row i, .agent-floating-dot { width: 5px; height: 5px; border-radius: 50%; background: #91c59f; }
.agent-task { position: relative; background: #ffffff04; border: 1px solid #ffffff0e; border-radius: 6px; margin-top: 17px; padding: 16px; }
.agent-task > div:first-child { display: flex; justify-content: space-between; font-size: 9px; color: #91a298; }
.agent-task small { font-size: 8px; }
.agent-task > strong { display: block; font-size: 12px; margin: 16px 0; font-weight: 500; }
.agent-progress { height: 4px; background: #ffffff12; border-radius: 2px; margin: 16px 35px 5px 0; }
.agent-progress > span { display: block; width: 68%; height: 100%; border-radius: inherit; background: #a0c4a7; }
.agent-percent { position: absolute; right: 15px; bottom: 18px; font-size: 9px; color: #b9c8bc; }
.agent-illustration { text-align: center; margin: 20px 0 0; font-size: 8px; color: #78877e; line-height: 1.8; }
.agent-floating { position: absolute; bottom: -28px; right: -15px; display: flex; gap: 18px; align-items: center; padding: 18px 22px; border-radius: 7px; background: #e5e8db; color: #2d3a2b; font-size: 12px; box-shadow: 0 15px 30px #0004; transform: rotate(2deg); }
.agent-floating > span:first-child { font-size: 21px; }
.agent-floating-dot { display: inline-block; background: #648768; }
.agent-architecture { padding-block: 30px 90px; }
.agent-page h2 { font-size: clamp(28px, 3vw, 40px); line-height: 1.45; letter-spacing: -1px; margin: 0; }
.agent-section-intro { max-width: 700px; color: #a1aba4; font-size: 13px; line-height: 1.95; margin: 25px 0 0; }
.agent-network { display: grid; grid-template-columns: 1fr .4fr .65fr .4fr 1.15fr; align-items: center; margin-top: 50px; gap: 18px; padding: 38px 28px; border: 1px solid #ffffff12; border-radius: 16px; background: radial-gradient(ellipse at 85% 25%, #777e6710, transparent 55%); }
.agent-network h3 { font-size: 13px; font-weight: 600; margin: 15px 0 7px; }
.agent-network p { font-size: 9px; line-height: 1.8; color: #909b92; margin: 0; }
.agent-web-node, .agent-gateway, .agent-local-node { text-align: center; min-width: 0; }
.agent-source-logos, .agent-downloader-logos { display: flex; align-items: center; justify-content: center; gap: 12px; }
.agent-source-logos > img, .agent-downloader-logos > img { width: 25px; height: 25px; object-fit: contain; }
.agent-source-logos > span { display: grid; place-items: center; width: 28px; height: 28px; border: 1px dashed #ffffff30; border-radius: 50%; color: #919e93; }
.agent-source-label { display: block; font-size: 9px; color: #8b9a8f; margin-top: 10px; }
.agent-network-up { display: block; color: #be7756; margin: 13px 0; }
.agent-popular-mark { font-size: 55px; color: var(--brand); font-weight: 800; line-height: 1; letter-spacing: -5px; }
.agent-gateway > span { font-size: 30px; color: #aaaf9e; }
.agent-connection { position: relative; display: grid; place-items: center; height: 25px; color: #b97a5d; font-size: 15px; overflow: hidden; }
.agent-connection > span { position: absolute; width: 100%; height: 1px; background: linear-gradient(90deg, #f0522d10, #f0522d99, #f0522d10); }
.agent-connection > span::after { content: ''; position: absolute; width: 16px; height: 1px; background: #f0bc93; left: 0; animation: agent-flow 3s linear infinite; }
.agent-connection b { z-index: 1; font-weight: 400; background: #111311; padding: 0 5px; }
.agent-local-node { position: relative; border: 1px solid #a0b09030; border-radius: 12px; background: #82917507; padding: 28px 16px 20px; }
.agent-local-label { position: absolute; top: -9px; left: 18px; background: #131613; padding: 0 8px; font-size: 9px; color: #adbdab; }
.agent-node-logo { width: 72px; height: 72px; object-fit: contain; }
.agent-network-down { display: block; color: #95a98b; margin: 17px 0; }
.agent-downloader-logos { flex-wrap: wrap; gap: 12px; }
.agent-downloader-logos > span { flex: 0 0 100%; font-size: 9px; color: #9caa9d; }
.agent-capabilities { display: grid; grid-template-columns: repeat(3, 1fr); gap: 36px; margin-top: 55px; }
.agent-capabilities article { border-top: 1px solid #ffffff1a; padding-top: 22px; }
.agent-capabilities article > span { color: var(--brand); font-size: 10px; }
.agent-capabilities h3 { font-size: 16px; line-height: 1.6; margin: 20px 0 12px; font-weight: 550; }
.agent-capabilities p { color: #a0a99f; font-size: 12px; line-height: 1.95; margin: 0; }
.agent-setup { background: #f0ede5; color: #243024; padding-block: 85px; scroll-margin-top: 85px; }
.agent-setup .agent-eyebrow { color: #697865; }
.agent-setup-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 90px; align-items: center; margin-top: 45px; }
.agent-steps { list-style: none; padding: 0; margin: 0; display: grid; gap: 27px; }
.agent-steps li { display: flex; gap: 20px; }
.agent-steps li > span { color: #a1694e; font-size: 11px; padding-top: 7px; }
.agent-steps h3 { font-size: 18px; font-weight: 650; margin: 0 0 10px; }
.agent-steps p { color: #697361; font-size: 12px; line-height: 1.95; margin: 0; }
.agent-config-window { padding: 24px; border: 1px solid #cdd3c3; border-radius: 13px; background: #fafbf5; box-shadow: 0 15px 40px #35482a13; }
.agent-config-heading { display: flex; gap: 10px; align-items: center; font-size: 14px; }
.agent-config-heading > img { width: 32px; height: 32px; object-fit: contain; }
.agent-config-heading .agent-window-dots { margin-left: auto; color: #b1b8aa; font-size: 7px; }
.agent-config-group { border-top: 1px solid #dce1d4; margin-top: 22px; padding-top: 18px; }
.agent-config-group h3 { display: flex; align-items: center; justify-content: space-between; font-size: 12px; margin: 0 0 20px; }
.agent-config-group h3 > span { font-size: 9px; font-weight: 400; color: #638059; }
.agent-config-field { margin: 14px 0 0; }
.agent-config-field > span, .agent-config-label { display: block; font-size: 10px; color: #76856c; margin-bottom: 7px; }
.agent-config-field > div { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px; background: #edf1e7; border: 1px solid #dfe5d6; border-radius: 5px; color: #718067; font-size: 10px; overflow-wrap: anywhere; }
.agent-config-field small { color: #8f9e83; font-size: 8px; }
.agent-config-providers { display: flex; gap: 10px; }
.agent-config-providers > span { display: grid; place-items: center; width: 50px; height: 40px; border: 1px solid #cad7bd; background: #edf1e7; border-radius: 5px; }
.agent-config-providers img { width: 24px; height: 24px; }
.agent-conditions { padding-block: 85px; }
.agent-conditions > div { display: grid; grid-template-columns: repeat(3, 1fr); gap: 38px; margin-top: 40px; }
.agent-conditions article { border-top: 1px solid #ffffff18; padding-top: 24px; }
.agent-conditions h3 { font-size: 15px; font-weight: 550; line-height: 1.6; margin: 0 0 13px; }
.agent-conditions p { font-size: 12px; line-height: 1.9; color: #9fa99f; margin: 0; }
.agent-closing { padding-block: 48px; background: #dce2cf; color: #253123; }
.agent-closing > div { display: flex; align-items: center; gap: 25px; }
.agent-closing img { width: 70px; height: 70px; object-fit: contain; }
.agent-closing h2 { font-size: 27px; }
.agent-closing p { font-size: 12px; color: #66755a; line-height: 1.8; margin: 12px 0 0; }
.agent-closing .agent-button { margin-left: auto; flex-shrink: 0; background: #263726; color: #eaf0df; }
.agent-footer { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding-block: 32px; }
.agent-footer > span { font-size: 9px; color: #828c82; }
.agent-page button:focus-visible, .agent-page a:focus-visible { outline: 2px solid var(--brand); outline-offset: 5px; }
@keyframes agent-flow { from { transform: translateX(-20px); } to { transform: translateX(180px); } }
@media (max-width: 1050px) { .agent-hero { gap: 40px; } .agent-device-title { gap: 9px; } .agent-device-title > img { width: 42px; height: 42px; } .agent-device-title strong { font-size: 12px; } .agent-setup-layout { gap: 45px; } .agent-network { gap: 10px; padding-inline: 20px; } }
@media (max-width: 800px) { .agent-container { width: calc(100% - 64px); } .agent-hero { grid-template-columns: 1fr; gap: 70px; padding-block: 35px 100px; } .agent-hero-art { max-width: 480px; width: calc(100% - 10px); margin-inline: auto; } .agent-hero h1 { font-size: 48px; } .agent-architecture { padding-bottom: 65px; } .agent-network { grid-template-columns: 1fr; gap: 15px; padding: 30px 24px; } .agent-web-node { padding-block: 5px; } .agent-source-logos { gap: 20px; } .agent-connection { width: 60px; margin-inline: auto; transform: rotate(90deg); } .agent-local-node { width: min(330px, 100%); margin-inline: auto; } .agent-capabilities { gap: 22px; } .agent-setup-layout { grid-template-columns: 1fr; gap: 35px; } .agent-config-window { width: min(450px, 100%); margin-inline: auto; } .agent-conditions > div { grid-template-columns: 1fr; gap: 25px; } .agent-closing > div { flex-wrap: wrap; gap: 18px; } .agent-closing > div > div { flex: 1; min-width: 220px; } .agent-closing .agent-button { margin-left: 0; } }
@media (max-width: 520px) { .agent-container { width: calc(100% - 40px); } .agent-header { padding-inline: 16px; gap: 15px; } .agent-header-actions { gap: 18px; } .agent-hero h1 { font-size: clamp(32px, 8vw, 43px); letter-spacing: -1.5px; } .agent-intro { font-size: 13px; } .agent-window { padding: 19px; } .agent-capabilities { grid-template-columns: 1fr; gap: 28px; } .agent-capabilities h3 { margin-top: 14px; } .agent-setup { padding-block: 55px; } .agent-conditions { padding-block: 55px; } .agent-closing h2 { font-size: 24px; } .agent-footer { flex-direction: column; align-items: flex-start; gap: 15px; } }
@media (prefers-reduced-motion: reduce) { .agent-connection > span::after { animation: none; } }
</style>
