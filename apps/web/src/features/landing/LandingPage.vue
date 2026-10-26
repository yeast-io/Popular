<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '../../i18n';
import { getIntegrationLogo } from '../settings/integration-logos';
import { landingMessages } from './landing.messages';
import { landingPreviewResources } from './landing-preview.presentation';
import BrandLogo from '../branding/BrandLogo.vue';
import LandingNotifications from './LandingNotifications.vue';
import LandingAgent from './LandingAgent.vue';
import discordLogo from '../../assets/integrations/discord.svg';
import githubLogo from '../../assets/integrations/github.svg';

defineProps<{ aiEnabled: boolean }>();
defineEmits<{ register: []; login: []; browse: []; agent: [] }>();
const { locale, setLocale } = useI18n();
const copy = computed(() => landingMessages[locale.value]);
const year = new Date().getFullYear();
const icons: Record<string, string> = {
  discover: 'm21 3-6 18-4-8-8-4L21 3ZM11 13l4-4',
  bookmark: 'M6 3h12v18l-6-4-6 4V3Z',
  heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
  connect: 'M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l2-2',
};
</script>

<template>
  <div class="lp">
    <header class="lp-header site-header-glass">
      <a class="lp-brand" href="/" aria-label="Popular"><BrandLogo /></a>
      <div class="lp-header-actions">
        <button class="lp-language" type="button" :aria-label="copy.language" @click="setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN')">{{ locale === 'zh-CN' ? 'EN' : '中文' }}</button>
        <button class="lp-signin" type="button" @click="$emit('login')">{{ copy.login }} <span aria-hidden="true">↗</span></button>
      </div>
    </header>

    <section class="lp-hero lp-container" aria-labelledby="lp-title">
      <div class="lp-hero-copy">
        <p class="lp-eyebrow"><span class="lp-spark" aria-hidden="true">✳</span>{{ copy.eyebrow }}</p>
        <h1 id="lp-title">{{ copy.title }}<br /><em>{{ copy.titleAccent }}</em></h1>
        <p class="lp-intro">{{ copy.intro }}</p>
        <div class="lp-hero-actions">
          <button class="lp-button" type="button" @click="$emit('login')">{{ copy.register }}<span aria-hidden="true">↗</span></button>
          <button class="lp-text-button" type="button" @click="$emit('browse')">{{ copy.browse }}<span aria-hidden="true">→</span></button>
        </div>
      </div>

      <div class="lp-showcase">
        <div class="lp-orbit" aria-hidden="true"></div>
        <div class="lp-preview">
          <div class="lp-preview-top"><span><span class="lp-preview-dot" aria-hidden="true"></span> {{ copy.preview }}</span></div>
          <div class="lp-resource-heading"><div><h2>{{ copy.previewHeading }}</h2><p class="lp-preview-sub">{{ copy.previewSub }}</p></div><span class="lp-result-count">{{ copy.resultCount }}</span></div>
          <div class="lp-resource-list">
            <article v-for="resource in landingPreviewResources" :key="resource.title" class="lp-resource-row">
              <div class="lp-release-heading"><span class="lp-release-quality">{{ resource.quality }}</span><span class="lp-release-size">{{ resource.size }}</span></div>
              <h3 :title="resource.title">{{ resource.title }}</h3>
              <div class="lp-release-stats"><span><small>{{ copy.seeders }}</small><strong>{{ resource.seeders }}</strong></span><span><small>{{ copy.leechers }}</small><strong>{{ resource.leechers }}</strong></span><span><small>{{ copy.discount }}</small><strong>{{ resource.discount }}</strong></span></div>
              <div class="lp-release-details"><span>{{ resource.video }}</span><span>{{ resource.audio }}</span><span v-for="tag in resource.tags" :key="tag">{{ tag }}</span><span>{{ copy.chineseSubtitles }}</span></div>
            </article>
          </div>
          <div class="lp-preview-bottom"><span>{{ copy.sendTo }}</span><span class="lp-preview-device"><img :src="getIntegrationLogo('qbittorrent')" alt="" />{{ copy.myDownloader }}</span><span class="lp-demo-submit" aria-hidden="true">↓</span></div>
        </div>
        <div class="lp-device-note"><span class="lp-device-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 4h16v12H4zM8 20h8m-4-4v4m-3-10 2 2 4-4" /></svg></span><span><strong>{{ copy.syncTitle }}</strong><small>{{ copy.syncText }}</small></span></div>
      </div>
    </section>

    <section id="features" class="lp-library" aria-labelledby="lp-features-title">
      <div class="lp-container">
        <div class="lp-section-heading">
          <div><p class="lp-eyebrow">{{ copy.libraryEyebrow }}</p><h2 id="lp-features-title">{{ copy.libraryTitle }}<br /><span>{{ copy.libraryAccent }}</span></h2></div>
          <p>{{ copy.libraryIntro }}</p>
        </div>
        <div class="lp-feature-grid">
          <article v-for="feature in copy.featureItems" :key="feature.number" class="lp-feature">
            <div class="lp-feature-top"><svg viewBox="0 0 24 24" aria-hidden="true"><path :d="icons[feature.icon]" /></svg><span>{{ feature.number }}</span></div>
            <h3>{{ feature.title }}</h3><p>{{ feature.text }}</p>
          </article>
        </div>
      </div>
    </section>

    <section id="downloader-connections" class="lp-connections lp-container" aria-labelledby="lp-connect-title">
      <div class="lp-connect-copy"><h2 id="lp-connect-title">{{ copy.connectionTitle }}<br /><span>{{ copy.connectionAccent }}</span></h2><p class="lp-section-copy">{{ copy.connectionIntro }}</p></div>
      <div class="lp-connection-options"><article v-for="(option, index) in copy.connectionOptions" :key="option.title"><span class="lp-option-number">0{{ index + 1 }}</span><div><h3>{{ option.title }}</h3><p>{{ option.text }}</p></div><svg viewBox="0 0 24 24" aria-hidden="true"><path v-if="index === 0" d="M7 18a5 5 0 0 1-1-10 6 6 0 0 1 11-1 5.5 5.5 0 0 1 0 11M12 12v9m-3-6 3-3 3 3" /><path v-else d="M4 4h16v12H4zM8 20h8m-4-4v4m-3-10 2 2 4-4" /></svg></article></div>
      <LandingAgent @open="$emit('agent')" />
    </section>

    <div class="lp-notification-band"><div class="lp-container"><LandingNotifications /></div></div>
    <aside v-if="aiEnabled" class="lp-ai lp-container"><span>{{ copy.aiLabel }}</span><div><h3>{{ copy.aiTitle }}</h3><p>{{ copy.aiText }}</p></div><span aria-hidden="true">✳</span></aside>

    <section id="getting-started" class="lp-start lp-container" aria-labelledby="lp-start-title">
      <p class="lp-eyebrow">{{ copy.stepsEyebrow }}</p><h2 id="lp-start-title">{{ copy.stepsTitle }}</h2>
      <ol class="lp-steps"><li v-for="(step, index) in copy.steps" :key="step.title"><span class="lp-step-number">0{{ index + 1 }}</span><h3>{{ step.title }}</h3><p>{{ step.text }}</p></li></ol>
    </section>

    <section class="lp-closing" aria-labelledby="lp-closing-title"><div class="lp-container"><span class="lp-closing-art" aria-hidden="true">✳</span><p class="lp-eyebrow">{{ copy.closingEyebrow }}</p><h2 id="lp-closing-title">{{ copy.closingTitle }}<br />{{ copy.closingAccent }}</h2><p>{{ copy.closingText }}</p><button class="lp-button lp-button-dark" type="button" @click="$emit('login')">{{ copy.register }}<span aria-hidden="true">↗</span></button></div></section>

    <footer class="lp-footer lp-container">
      <div class="lp-footer-grid">
        <div class="lp-footer-brand"><a class="lp-brand" href="/"><BrandLogo /></a><p>{{ copy.footerTagline }}</p></div>
        <nav class="lp-footer-links" :aria-label="copy.footerHelp"><h3>{{ copy.footerHelp }}</h3><a href="#getting-started">{{ copy.footerPreparation }}</a><a href="/link-agent" @click.prevent="$emit('agent')">{{ copy.footerPla }}</a><a href="https://github.com/yeast-io/Popular/issues" target="_blank" rel="noopener noreferrer">{{ copy.footerFeedback }}</a></nav>
        <div class="lp-footer-community"><h3>{{ copy.footerCommunity }}</h3><a class="lp-footer-social" href="https://github.com/yeast-io/Popular" target="_blank" rel="noopener noreferrer"><img :src="githubLogo" alt="" /><span>{{ copy.footerGithub }}</span><span aria-hidden="true">↗</span></a><div class="lp-footer-placeholder" aria-disabled="true"><img :src="getIntegrationLogo('telegram')" alt="Telegram" /><span>{{ copy.footerTelegram }}</span><small>{{ copy.footerComingSoon }}</small></div><div class="lp-footer-placeholder" aria-disabled="true"><img :src="discordLogo" alt="Discord" /><span>{{ copy.footerDiscord }}</span><small>{{ copy.footerComingSoon }}</small></div></div>
      </div>
      <div class="lp-footer-bottom"><span>© {{ year }} Popular</span><details class="lp-disclaimer"><summary>{{ copy.disclaimerTitle }}<span aria-hidden="true">＋</span></summary><p>{{ copy.disclaimer }}</p></details></div>
    </footer>
  </div>
</template>

<style scoped>
:global(.app-shell.landing-shell) { width: 100%; padding-bottom: 0; }
.lp { --lp-muted: #a6a7a9; --lp-paper: #f0ede5; color: var(--lp-paper); overflow: clip; }
.lp-container { width: min(1200px, calc(100% - 96px)); margin-inline: auto; }
.lp button, .lp a, .lp summary { -webkit-tap-highlight-color: transparent; }
.lp button:focus-visible, .lp a:focus-visible, .lp summary:focus-visible { outline: 2px solid var(--brand); outline-offset: 5px; }
.lp-header { position: sticky; z-index: 10; top: 0; width: 100%; margin: 0; padding: 18px 24px; display: flex; align-items: center; justify-content: space-between; gap: 28px; border-bottom: 1px solid var(--line); }
.lp-brand { display: inline-flex; align-items: center; }
.lp-header-actions { display: flex; align-items: center; gap: 30px; }
.lp-language { border: 0; background: transparent; color: #b8b8b6; font-size: 12px; padding: 10px 0; }
.lp-signin { border: 1px solid #414243; padding: 7px 14px; color: #ccc; background: transparent; border-radius: 999px; font-size: .78rem; font-weight: 700; }
.lp-signin span { margin-left: 16px; }
.lp-hero { display: grid; grid-template-columns: 1fr 1fr; align-items: center; gap: 60px; min-height: 690px; padding-block: 95px 105px; }
.lp-eyebrow { display: flex; align-items: center; gap: 9px; margin: 0 0 27px; font-size: 11px; line-height: 1.6; font-weight: 700; letter-spacing: 2px; color: var(--lp-muted); }
.lp-spark { color: var(--brand); font-size: 23px; line-height: 1; }
.lp-hero h1 { margin: 0; font-size: clamp(48px, 4.7vw, 72px); font-weight: 760; line-height: 1.23; letter-spacing: -3px; }
.lp-hero h1 em { color: var(--brand); font-style: normal; }
.lp-intro { max-width: 440px; margin: 27px 0 32px; color: #b8b8b6; font-size: 15px; line-height: 1.95; }
.lp-hero-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 25px; }
.lp-button { display: inline-flex; align-items: center; justify-content: center; gap: 28px; padding: 17px 23px; background: var(--brand); color: #100f0e; border: 1px solid transparent; border-radius: 6px; font-size: 13px; font-weight: 750; transition: transform .2s, background .2s; }
.lp-button:hover { background: #ff6c43; transform: translateY(-2px); }
.lp-button span { font-size: 20px; line-height: 1; }
.lp-text-button { display: inline-flex; align-items: center; gap: 12px; padding: 12px 0; background: transparent; color: var(--lp-paper); border: 0; font-size: 13px; }
.lp-text-button:hover { color: var(--brand); }
.lp-showcase { position: relative; min-width: 0; isolation: isolate; }
.lp-orbit { position: absolute; z-index: -1; width: 520px; height: 520px; left: -5px; top: -45px; border: 1px solid #f0522d38; border-radius: 50%; box-shadow: 0 0 0 36px #f0522d05, 0 0 0 72px #f0522d04; transform: rotate(-25deg) scaleY(.86); }
.lp-orbit::after { content: ''; position: absolute; top: 54px; right: 57px; width: 13px; height: 13px; border-radius: 50%; background: var(--brand); box-shadow: 0 0 35px #f0522d60; }
.lp-preview { position: relative; padding: 24px; background: #131416; border: 1px solid #ffffff20; border-radius: 13px; transform: rotate(-2deg); box-shadow: 0 35px 80px #0008; }
.lp-preview-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: #d5d5d2; font-size: 11px; }
.lp-preview-dot { display: inline-block; width: 6px; height: 6px; background: var(--brand); border-radius: 50%; }
.lp-preview h2 { font-size: 21px; letter-spacing: -.6px; margin: 21px 0 7px; }
.lp-preview-sub { font-size: 10px; color: #8d8f95; margin: 0 0 22px; }
.lp-preview-bottom { display: flex; align-items: center; gap: 8px; border-top: 1px solid #ffffff10; margin-top: 20px; padding-top: 15px; font-size: 10px; color: #b7b9b9; }
.lp-preview-bottom > span { color: var(--brand); font-size: 17px; }
.lp-preview-bottom svg { margin-left: auto; width: 15px; height: 15px; fill: none; stroke: #93b99d; stroke-width: 2; }
.lp-device-note { position: absolute; right: -20px; bottom: -65px; max-width: 90%; display: flex; align-items: center; gap: 13px; padding: 17px 20px; color: #242b25; background: #e6e9d9; border-radius: 8px; transform: rotate(2deg); box-shadow: 0 12px 35px #0006; }
.lp-device-icon { display: grid; place-items: center; width: 37px; height: 37px; flex: 0 0 37px; background: #d4dbc4; border-radius: 50%; }
.lp-device-icon svg { width: 23px; height: 23px; fill: none; stroke: #3b4b36; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.lp-device-note strong, .lp-device-note small { display: block; }
.lp-device-note strong { font-size: 12px; }
.lp-device-note small { font-size: 9px; margin-top: 5px; line-height: 1.6; color: #626a5b; }
.lp-library { color: #1f2523; background: var(--lp-paper); padding-block: 90px; }
.lp-section-heading { display: grid; grid-template-columns: 1.4fr 1fr; gap: 80px; align-items: end; }
.lp-library .lp-eyebrow { color: #747770; }
.lp h2 { text-wrap: balance; }
.lp-section-heading h2, .lp-connect-copy h2, .lp-start h2 { font-size: clamp(29px, 3vw, 43px); line-height: 1.4; font-weight: 650; letter-spacing: -1.5px; margin: 0; }
.lp-section-heading h2 span { color: #82877b; }
.lp-section-heading > p { font-size: 13px; line-height: 1.95; color: #666c62; margin: 0 0 7px; max-width: 380px; }
.lp-feature-grid { margin-top: 54px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.lp-feature { border-top: 1px solid #bfc4b5; padding: 24px 25px 0; border-right: 1px solid #cfd2c7; }
.lp-feature:first-child { padding-left: 0; }
.lp-feature:last-child { border-right: 0; padding-right: 0; }
.lp-feature-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 36px; }
.lp-feature-top svg { width: 25px; height: 25px; fill: none; stroke: #475b42; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.lp-feature-top > span { font-size: 10px; color: #858b7d; }
.lp-feature h3 { font-size: 16px; line-height: 1.6; font-weight: 650; margin: 0 0 12px; }
.lp-feature > p { font-size: 12px; line-height: 1.9; color: #6b7165; margin: 0; }
.lp-connections { padding-block: 95px 0; }
.lp-connect-copy { text-align: center; }
.lp-connect-copy .lp-eyebrow { justify-content: center; }
.lp-connect-copy h2 span { color: #868b86; }
.lp-section-copy { max-width: 560px; margin: 24px auto 0; font-size: 13px; line-height: 1.9; color: var(--lp-muted); }
.lp-ai { display: flex; align-items: center; gap: 28px; max-width: 850px; margin: 0 auto; padding: 28px 0; border-bottom: 1px solid var(--line); }
.lp-ai > :first-child { color: var(--brand); font-size: 10px; letter-spacing: 1px; flex-shrink: 0; }
.lp-ai > :last-child { font-size: 35px; color: var(--brand); margin-left: auto; }
.lp-start { padding-block: 100px 80px; }
.lp-steps { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 48px; list-style: none; padding: 0; margin: 44px 0 0; }
.lp-steps li { border-top: 1px solid var(--line); padding-top: 25px; }
.lp-step-number { color: var(--brand); font-size: 12px; font-variant-numeric: tabular-nums; }
.lp-steps h3 { font-size: 20px; margin: 20px 0 12px; font-weight: 550; }
.lp-steps p { font-size: 13px; line-height: 1.9; color: var(--lp-muted); max-width: 280px; margin: 0; }
.lp-disclaimer summary { display: flex; align-items: center; justify-content: space-between; gap: 20px; cursor: pointer; list-style: none; padding-block: 23px; font-size: 13px; line-height: 1.7; }
.lp summary::-webkit-details-marker { display: none; }
.lp-disclaimer summary > span { color: var(--brand); transition: transform .2s; }
.lp-disclaimer[open] summary > span { transform: rotate(45deg); }
.lp-closing { position: relative; background: var(--brand); color: #171b15; padding: 72px 0; overflow: hidden; }
.lp-closing .lp-container { position: relative; }
.lp-closing .lp-eyebrow { color: #522e21; }
.lp-closing h2 { font-size: clamp(36px, 4vw, 55px); line-height: 1.35; letter-spacing: -2px; margin: 0; font-weight: 700; position: relative; }
.lp-closing p:not(.lp-eyebrow) { font-size: 13px; margin: 23px 0; line-height: 1.8; position: relative; }
.lp-button-dark { color: var(--lp-paper); background: #1b211b; position: relative; }
.lp-button-dark:hover { background: #2f382f; }
.lp-closing-art { position: absolute; right: 0; top: 50%; transform: translateY(-50%) rotate(15deg); font-size: 330px; line-height: 1; color: #5a2c1b; opacity: .2; }
.lp-footer { padding-block: 55px 32px; }
.lp-footer-grid { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 55px; }
.lp-footer-brand p { color: #919497; font-size: 11px; margin: 12px 0 0; line-height: 1.8; max-width: 240px; }
.lp-footer-grid h3 { font-size: 12px; font-weight: 600; color: #d3d5d0; margin: 0 0 22px; }
.lp-footer-links { display: flex; flex-direction: column; align-items: flex-start; gap: 15px; }
.lp-footer-links h3 { margin-bottom: 7px; }
.lp-footer-links a { color: #9b9f9c; font-size: 11px; line-height: 1.7; }
.lp-footer-links a:hover { color: var(--lp-paper); }
.lp-footer-placeholder { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; color: #8b908c; font-size: 11px; line-height: 1.7; }
.lp-footer-placeholder small { font-size: 8px; color: #727b71; padding: 2px 6px; border: 1px solid #ffffff12; border-radius: 4px; white-space: nowrap; }
.lp-footer-community > div, .lp-footer-social { margin-top: 16px; }
.lp-footer-social { display: flex; align-items: center; gap: 9px; color: #b6bdb4; font-size: 11px; line-height: 1.7; }
.lp-footer-social:hover { color: var(--lp-paper); }
.lp-footer-social > span:last-child { font-size: 12px; color: #85907e; }
.lp-footer-community img { width: 20px; height: 20px; object-fit: contain; }
.lp-footer-bottom { display: flex; justify-content: space-between; align-items: flex-start; gap: 28px; margin-top: 38px; padding-top: 20px; border-top: 1px solid var(--line); }
.lp-footer-bottom > span { flex-shrink: 0; font-size: 10px; color: #85888c; line-height: 1.8; }
@media (max-width: 800px) { .lp-footer-grid { grid-template-columns: 1fr 1fr; gap: 32px 24px; } .lp-footer-brand { grid-column: 1 / -1; } }
@media (max-width: 480px) { .lp-footer { padding-top: 40px; } .lp-footer-placeholder { gap: 7px; } .lp-footer-community img { width: 18px; height: 18px; } }
.lp-disclaimer { margin: 0; max-width: 880px; }
.lp-disclaimer summary { justify-content: flex-start; color: #92969c; font-size: 11px; padding-block: 0; }
.lp-disclaimer p { max-width: 880px; font-size: 11px; line-height: 1.9; color: #92969c; margin: 14px 0 0; }
.lp section[id] { scroll-margin-top: 100px; }
@media (min-width: 1440px) { .lp-hero h1 { font-size: 72px; } }
@media (max-width: 700px) {
  .lp-header { width: 100%; padding-top: calc(18px + env(safe-area-inset-top, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-left: max(16px, env(safe-area-inset-left, 0px)); }
}
@media (max-width: 1050px) {
  .lp-container { width: calc(100% - 64px); }
  .lp-hero { gap: 35px; min-height: 620px; padding-block: 80px 95px; }
  .lp-hero h1 { font-size: 48px; letter-spacing: -2px; }
  .lp-preview { padding: 20px; }
  .lp-device-note { right: -10px; }
  .lp-section-heading { gap: 40px; }
  .lp-feature { padding-inline: 18px; }
  .lp-feature h3 { font-size: 14px; }
}
@media (max-width: 800px) {
  .lp-hero { grid-template-columns: 1fr; gap: 65px; padding-block: 60px 85px; }
  .lp-hero-copy { max-width: 600px; }
  .lp-hero h1 { font-size: clamp(45px, 7.5vw, 64px); }
  .lp-intro { max-width: 510px; }
  .lp-showcase { width: min(500px, calc(100% - 20px)); margin: 0 auto; }
  .lp-orbit { left: -10px; }
  .lp-section-heading { grid-template-columns: 1fr; gap: 25px; }
  .lp-section-heading > p { max-width: 520px; }
  .lp-feature-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 35px 0; }
  .lp-feature { padding-inline: 25px; }
  .lp-feature:nth-child(odd) { padding-left: 0; }
  .lp-feature:nth-child(even) { border-right: 0; padding-right: 0; }
  .lp-feature-top { margin-bottom: 25px; }
  .lp-feature h3 { font-size: 16px; }
  .lp-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 30px 25px; }
  .lp-closing-art { right: -70px; font-size: 270px; }
}
@media (max-width: 480px) {
  .lp-container { width: calc(100% - 40px); }
  .lp-header { gap: 15px; }
  .lp-header-actions { gap: 18px; }
  .lp-signin { font-size: 12px; }
  .lp-signin span { margin-left: 7px; }
  .lp-hero { padding-top: 45px; gap: 55px; }
  .lp-hero h1 { font-size: 43px; letter-spacing: -2px; }
  .lp-eyebrow { font-size: 9px; letter-spacing: 1.4px; margin-bottom: 23px; }
  .lp-intro { font-size: 13px; margin-block: 23px 26px; }
  .lp-hero-actions { gap: 18px; }
  .lp-button { font-size: 12px; padding: 16px 18px; gap: 17px; }
  .lp-text-button { font-size: 12px; }
  .lp-preview { padding: 17px; border-radius: 10px; }
  .lp-preview-top { font-size: 10px; }
  .lp-preview h2 { font-size: 18px; }
  .lp-device-note { padding: 12px 14px; gap: 10px; }
  .lp-device-note strong { font-size: 10px; }
  .lp-device-note small { font-size: 8px; }
  .lp-library { padding-block: 58px; }
  .lp-section-heading h2, .lp-connect-copy h2, .lp-start h2 { font-size: 28px; letter-spacing: -1px; }
  .lp-section-heading > p, .lp-section-copy { font-size: 12px; }
  .lp-feature { padding-inline: 16px; }
  .lp-feature h3 { font-size: 14px; }
  .lp-feature > p { font-size: 11px; }
  .lp-connections { padding-top: 60px; }
  .lp-ai { gap: 15px; align-items: flex-start; }
  .lp-ai > :first-child { font-size: 8px; padding-top: 3px; }
  .lp-ai > :last-child { display: none; }
  .lp-ai h3 { font-size: 13px; }
  .lp-ai p { font-size: 11px; }
  .lp-start { padding-block: 65px 50px; }
  .lp-steps { grid-template-columns: 1fr; gap: 23px; margin-top: 30px; }
  .lp-steps li { display: grid; grid-template-columns: 32px 1fr; column-gap: 12px; padding-top: 20px; }
  .lp-step-number { grid-row: 1 / 3; padding-top: 5px; }
  .lp-steps h3 { font-size: 18px; margin: 0 0 8px; }
  .lp-steps p { font-size: 12px; max-width: none; }
  .lp-closing { padding-block: 52px; }
  .lp-closing h2 { font-size: 35px; letter-spacing: -1px; }
  .lp-closing-art { right: -60px; font-size: 210px; }
  .lp-closing p:not(.lp-eyebrow) { font-size: 12px; max-width: 250px; }
}
@media (prefers-reduced-motion: reduce) { .lp *, .lp *::before, .lp *::after { transition: none !important; scroll-behavior: auto !important; } }

.lp-resource-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.lp-resource-heading h2 { font-size: 21px; margin-top: 24px; }
.lp-resource-heading .lp-preview-sub { margin-bottom: 22px; line-height: 1.6; }
.lp-result-count { white-space: nowrap; color: #94979d; font-size: 10px; }
.lp-resource-list { display: grid; gap: 12px; }
.lp-resource-row { min-width: 0; padding: 17px; border: 1px solid #ffffff16; border-radius: 8px; background: linear-gradient(120deg, #ffffff05, #ffffff01); }
.lp-release-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.lp-release-quality { font-size: 10px; font-weight: 700; color: #e6b178; letter-spacing: .5px; }
.lp-release-size { color: #bfc1c5; font-size: 11px; font-variant-numeric: tabular-nums; }
.lp-resource-row h3 { font: 600 11px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; color: #e3e3de; margin: 10px 0 15px; overflow-wrap: anywhere; }
.lp-release-stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
.lp-release-stats > span { padding: 8px 10px; border-left: 2px solid #ffffff30; background: #ffffff04; }
.lp-release-stats > span:first-child { background: #82d6a512; border-color: #82d6a5; }
.lp-release-stats > span:nth-child(2) { background: #e9b4520c; border-color: #d9a340; }
.lp-release-stats small, .lp-release-stats strong { display: block; }
.lp-release-stats small { color: #a3a7ad; font-size: 9px; line-height: 1.5; }
.lp-release-stats strong { font-size: 17px; margin-top: 4px; font-variant-numeric: tabular-nums; }
.lp-release-stats > span:first-child strong { color: #9bdcb4; }
.lp-release-details { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 13px; }
.lp-release-details > span { color: #aeb2b7; border: 1px solid #ffffff20; border-radius: 4px; padding: 3px 6px; font-size: 8px; line-height: 1.4; }
.lp-preview-bottom { gap: 12px; padding-top: 16px; margin-top: 16px; }
.lp-preview-bottom > span { color: #aeb2b7; font-size: 10px; }
.lp-preview-device { display: inline-flex; align-items: center; gap: 7px; color: #d1d3d6; }
.lp-preview-device img { width: 17px; height: 17px; }
.lp-preview-bottom .lp-demo-submit { margin-left: auto; display: grid; place-items: center; width: 32px; height: 30px; border: 1px solid #ffffff2a; border-radius: 5px; color: #d6d7d8; font-size: 18px; }
@media (min-width: 801px) { .lp-feature-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 800px) { .lp-feature-grid { grid-template-columns: 1fr; gap: 25px; } .lp-feature, .lp-feature:nth-child(even) { border-right: 0; padding: 22px 0 0; } .lp-feature-top { margin-bottom: 18px; } }
@media (max-width: 480px) {
  .lp-resource-row { padding: 13px; }
  .lp-resource-row h3 { font-size: 10px; }
  .lp-resource-heading h2 { font-size: 18px; }
  .lp-result-count { font-size: 9px; }
  .lp-release-stats > span { padding: 7px; }
  .lp-release-stats strong { font-size: 15px; }
  .lp-hero h1 { font-size: clamp(34px, 8.5vw, 43px); }
}
.lp-connection-options { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin-top: 40px; }
.lp-connection-options article { display: flex; align-items: flex-start; gap: 16px; padding-block: 24px; }
.lp-option-number { color: var(--brand); font-size: 10px; padding-top: 5px; }
.lp-connection-options h3 { font-size: 18px; font-weight: 600; margin: 0 0 12px; line-height: 1.6; }
.lp-connection-options p { color: #a6a7a9; font-size: 12px; line-height: 1.9; margin: 0; }
.lp-connection-options svg { flex: 0 0 27px; width: 27px; height: 27px; margin-left: auto; fill: none; stroke: #9cae91; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
@media (max-width: 600px) { .lp-connection-options { grid-template-columns: 1fr; gap: 5px; margin-top: 30px; } }
.lp-notification-band { background: var(--lp-paper); margin-top: 60px; padding-block: 72px 80px; }
@media (max-width: 600px) { .lp-notification-band { margin-top: 45px; padding-block: 45px 50px; } }
</style>
