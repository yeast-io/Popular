<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from '../../i18n';
import { getIntegrationLogo } from '../settings/integration-logos';
import { landingNotificationMessages } from './landing-notifications.messages';

const { locale } = useI18n();
const copy = computed(() => landingNotificationMessages[locale.value]);
const selectedNotification = ref<'availability' | 'completion'>('availability');
const step = ref(0);
const playing = ref(true);
const visible = ref(false);
const container = ref<HTMLElement>();
const chat = ref<HTMLElement>();
const messages = computed(() => copy.value.messages.filter((message) => message.step <= step.value));
watch(() => messages.value.length, async () => {
  await nextTick();
  if (chat.value) chat.value.scrollTop = chat.value.scrollHeight;
});
let timer: ReturnType<typeof setInterval> | undefined;
let observer: IntersectionObserver | undefined;
let motion: MediaQueryList | undefined;
function replay() {
  step.value = 0;
  playing.value = true;
  if (chat.value) chat.value.scrollTop = 0;
}
function togglePlayback() {
  if (!playing.value && step.value === 4) replay();
  else playing.value = !playing.value;
}
function reduceMotion() {
  if (motion?.matches) {
    playing.value = false;
    step.value = 4;
  }
}
onMounted(() => {
  motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  reduceMotion();
  motion?.addEventListener('change', reduceMotion);
  if (typeof IntersectionObserver !== 'undefined' && container.value) {
    observer = new IntersectionObserver(([entry]) => {
      visible.value = Boolean(entry?.isIntersecting);
    }, { threshold: 0.2 });
    observer.observe(container.value);
  } else visible.value = true;
  timer = setInterval(() => {
    if (!playing.value || !visible.value) return;
    if (step.value === 4) {
      playing.value = false;
      return;
    }
    step.value++;
    if (step.value === 4) playing.value = false;
  }, 3200);
});
onUnmounted(() => {
  clearInterval(timer);
  observer?.disconnect();
  motion?.removeEventListener('change', reduceMotion);
});
</script>

<template>
  <div class="ln">
    <div class="ln-notification-grid">
      <div class="ln-notification-choices">
        <button v-for="kind in ['availability', 'completion'] as const" :key="kind" class="ln-notification" type="button" :aria-pressed="selectedNotification === kind" aria-controls="landing-notification-preview" @click="selectedNotification = kind">
          <span class="ln-caption"><span>{{ kind === 'completion' ? '02' : '01' }}</span><strong>{{ copy[kind] }}</strong><span class="ln-choice-arrow" aria-hidden="true">↗</span></span>
          <span class="ln-description">{{ kind === 'completion' ? copy.completionText : copy.availabilityText }}</span>
        </button>
      </div>
        <div id="landing-notification-preview" class="ln-phone" role="region" :aria-label="copy[selectedNotification]">
          <div class="ln-channel"><img :src="getIntegrationLogo('whatsapp')" alt="WhatsApp" /><span>Popular<small>{{ copy.channel }}</small></span><span class="ln-channel-dot" aria-hidden="true"></span></div>
          <div class="ln-message">
            <div class="ln-status"><span aria-hidden="true">{{ selectedNotification === 'completion' ? '✓' : '↗' }}</span>{{ selectedNotification === 'completion' ? copy.completed : copy.found }}</div>
            <div class="ln-film-art" :class="{ 'ln-film-art-ready': selectedNotification === 'completion' }" aria-hidden="true"><span class="ln-planet"></span><span class="ln-orbit"></span><span class="ln-art-caption">{{ copy.film }}</span></div>
            <h4>{{ copy.film }}</h4><small class="ln-film-meta">{{ copy.genre }}</small>
            <p>{{ selectedNotification === 'completion' ? copy.readyText : copy.foundText }}</p>
            <div class="ln-metadata">{{ selectedNotification === 'completion' ? copy.ready : copy.resource }}</div>
            <div class="ln-message-link">{{ copy.details }}<span aria-hidden="true">↗</span></div>
          </div>
        </div>
    </div>

    <div ref="container" class="ln-flow">
      <div class="ln-flow-copy"><p class="ln-eyebrow">{{ copy.flowEyebrow }}</p><h3>{{ copy.flowTitle }}</h3><p>{{ copy.flowIntro }}</p>
        <ol class="ln-stages"><li v-for="(label, index) in copy.stages" :key="label" :class="{ 'is-current': step === index, 'is-done': step > index }"><button type="button" :aria-current="step === index ? 'step' : undefined" @click="step = index; playing = false"><span>{{ step > index ? '✓' : `0${index + 1}` }}</span>{{ label }}</button></li></ol>
        <div class="ln-controls"><button type="button" :aria-pressed="playing" @click="togglePlayback">{{ playing ? copy.pause : copy.play }}</button><button type="button" @click="replay">{{ copy.replay }}<span aria-hidden="true">↻</span></button></div>
      </div>
      <div class="ln-conversation">
        <div class="ln-channel"><img :src="getIntegrationLogo('whatsapp')" alt="WhatsApp" /><span>Popular</span><span class="ln-channel-dot" aria-hidden="true"></span></div>
        <div ref="chat" class="ln-chat" aria-live="off"><div v-for="(message, index) in messages" :key="`${locale}-${index}`" class="ln-bubble" :class="`ln-bubble-${message.side}`"><span>{{ message.text }}</span><small v-if="message.side === 'out'" aria-hidden="true">✓✓</small></div><div v-if="playing && step < 4" class="ln-typing" :aria-label="copy.typing"><i></i><i></i><i></i></div></div>
        <div class="ln-flow-progress" aria-hidden="true"><span v-for="index in 5" :key="index" :class="{ active: index <= step + 1 }"></span></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ln { margin-top: 0; color: #243024; }
.ln-phone, .ln-conversation { color: #f0ede5; }
.ln-notification-grid { display: grid; grid-template-columns: 1fr 1fr; align-items: center; gap: 70px; max-width: 930px; margin-inline: auto; }
.ln-notification-choices { display: grid; gap: 14px; }
.ln-notification { width: 100%; text-align: left; background: #ffffff20; border: 1px solid #d0d2c7; border-radius: 9px; padding: 23px; color: inherit; transition: background .2s, border-color .2s; }
.ln-notification:hover { border-color: #aebca4; }
.ln-notification[aria-pressed="true"] { background: #e3e7d9; border-color: #8e9b7f; }
.ln-choice-arrow { margin-left: auto; opacity: 0; }
.ln-notification[aria-pressed="true"] .ln-choice-arrow { opacity: 1; }
.ln-caption { display: flex; gap: 13px; align-items: center; }
.ln-caption > span { font-size: 11px; color: var(--brand); }
.ln-caption strong { font-size: 18px; font-weight: 600; line-height: 1.6; }
.ln-description { display: block; color: #65705f; font-size: 12px; line-height: 1.9; margin: 12px 0 0; }
.ln-phone { width: min(340px, 100%); justify-self: center; background: #101c20; padding: 0 16px 16px; border-radius: 14px; border: 1px solid #ffffff1c; }
.ln-channel { display: flex; align-items: center; gap: 12px; padding: 17px 0; }
.ln-channel > img { width: 27px; height: 27px; }
.ln-channel > span { font-size: 13px; color: #e4ece8; font-weight: 600; }
.ln-channel small { display: block; font-size: 9px; font-weight: 400; color: #8a9c99; margin-top: 4px; line-height: 1.5; }
.ln-channel > .ln-channel-dot { width: 6px; height: 6px; background: #69bd95; border-radius: 50%; margin-left: auto; flex-shrink: 0; }
.ln-message { background: #1d3034; padding: 16px; border-radius: 3px 12px 12px; box-shadow: 0 9px 25px #0002; }
.ln-status { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 650; color: #b9e3cd; margin-bottom: 13px; }
.ln-status > span { display: grid; place-items: center; width: 20px; height: 20px; background: #80cfaa17; border-radius: 50%; }
.ln-film-art { position: relative; isolation: isolate; height: 110px; overflow: hidden; border-radius: 5px; background: radial-gradient(ellipse at 70% 15%, #bd987057, transparent 55%), linear-gradient(135deg, #24434b, #0b1928); }
.ln-planet { position: absolute; width: 145px; height: 145px; border-radius: 50%; top: -18px; right: 35px; background: radial-gradient(circle at 30% 30%, #d6c499, #5d7c80 45%, #102938 74%); box-shadow: -8px -3px 40px #c6e4e012; }
.ln-orbit { position: absolute; width: 390px; height: 90px; border: 1px solid #c7d6c761; border-radius: 50%; transform: rotate(-25deg); top: 55px; left: 10px; }
.ln-film-art::after { content: ''; position: absolute; inset: 0; z-index: 1; background: linear-gradient(transparent, #0b1725bb); }
.ln-film-art-ready { background: radial-gradient(ellipse at 10% 0%, #cd845248, transparent 65%), linear-gradient(135deg, #38453c, #0c1b27); }
.ln-film-art-ready .ln-planet { right: 70px; top: -45px; }
.ln-art-caption { position: absolute; z-index: 2; bottom: 16px; left: 18px; right: 18px; color: #f0e5d0; font-size: 18px; font-weight: 650; letter-spacing: 2px; }
.ln-message h4 { margin: 16px 0 5px; font-size: 15px; font-weight: 600; }
.ln-film-meta { font-size: 10px; color: #9aafaf; }
.ln-message p { font-size: 12px; line-height: 1.9; color: #c5d2d0; margin: 13px 0; }
.ln-metadata { font-size: 10px; line-height: 1.7; color: #a3beb6; padding: 10px 0 14px; }
.ln-message-link { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #a9d5ca; border-top: 1px solid #ffffff13; padding-top: 13px; }
.ln-flow { display: grid; grid-template-columns: .9fr 1.1fr; gap: 70px; align-items: center; margin-top: 90px; }
.ln-eyebrow { font-size: 10px; letter-spacing: 1.5px; color: #687c62; margin: 0 0 18px; }
.ln-flow-copy h3 { font-size: clamp(26px, 3vw, 36px); line-height: 1.5; margin: 0 0 22px; font-weight: 600; letter-spacing: -1px; }
.ln-flow-copy > p:not(.ln-eyebrow) { color: #65705f; font-size: 13px; line-height: 1.9; }
.ln-stages { list-style: none; margin: 28px 0; padding: 0; display: grid; gap: 4px; }
.ln-stages button { display: flex; align-items: center; gap: 14px; width: 100%; border: 0; background: transparent; color: #7f8986; text-align: left; padding: 9px 0; font-size: 12px; }
.ln-stages button > span { display: grid; place-items: center; font-size: 10px; font-variant-numeric: tabular-nums; width: 25px; height: 25px; border-radius: 50%; border: 1px solid #d4dccf; }
.ln-stages .is-current button { color: #253621; }
.ln-stages .is-current button > span { color: #b84424; border-color: #f0522d70; background: #f0522d12; }
.ln-stages .is-done button { color: #526f47; }
.ln-controls { display: flex; gap: 18px; }
.ln-controls button { display: flex; align-items: center; gap: 12px; padding: 8px 0; border: 0; border-bottom: 1px solid #c5d0bd; background: transparent; color: #46563e; font-size: 11px; }
.ln-conversation { border: 1px solid #ffffff1e; border-radius: 13px; background: #101c20; overflow: hidden; }
.ln-conversation > .ln-channel { padding: 18px 22px; background: #18292d; }
.ln-chat { height: 470px; overflow-y: auto; padding: 23px 20px; display: flex; flex-direction: column; gap: 13px; scrollbar-width: thin; scrollbar-color: #536460 transparent; background-image: radial-gradient(#74908212 1px, transparent 1px); background-size: 18px 18px; }
.ln-bubble { max-width: 88%; padding: 12px 14px; font-size: 12px; line-height: 1.8; color: #dce6e2; box-shadow: 0 4px 10px #0001; animation: ln-message-in .3s ease-out; flex-shrink: 0; }
.ln-bubble-in { align-self: flex-start; border-radius: 0 9px 9px; background: #21363a; }
.ln-bubble-out { align-self: flex-end; border-radius: 9px 0 9px 9px; background: #164b40; }
.ln-bubble small { display: block; text-align: right; color: #9bcece; font-size: 9px; line-height: 1; margin-top: 6px; }
.ln-typing { display: flex; align-self: flex-start; gap: 4px; padding: 12px; border-radius: 8px; background: #21363a; }
.ln-typing i { width: 4px; height: 4px; border-radius: 50%; background: #9aada5; animation: ln-typing 1s infinite alternate; }
.ln-typing i:nth-child(2) { animation-delay: .2s; }
.ln-typing i:nth-child(3) { animation-delay: .4s; }
.ln-flow-progress { display: flex; gap: 4px; padding: 15px 22px; }
.ln-flow-progress span { height: 2px; flex: 1; background: #ffffff12; }
.ln-flow-progress .active { background: #6cb18e; }
.ln button:focus-visible { outline: 2px solid var(--brand); outline-offset: 4px; }
@keyframes ln-message-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes ln-typing { from { opacity: .3; } to { opacity: 1; } }
@media (max-width: 800px) { .ln-notification-grid { gap: 22px; } .ln-phone { padding: 0 14px 14px; } .ln-message { padding: 12px; } .ln-flow { grid-template-columns: 1fr; gap: 28px; margin-top: 65px; } .ln-stages { grid-template-columns: repeat(5, 1fr); gap: 8px; } .ln-stages button { flex-direction: column; align-items: flex-start; gap: 8px; line-height: 1.6; font-size: 10px; } }
@media (max-width: 600px) { .ln-notification-grid { grid-template-columns: 1fr; gap: 25px; } .ln-notification-choices { grid-template-columns: 1fr 1fr; gap: 12px; } .ln-notification { padding: 16px 13px; } .ln-caption { gap: 8px; } .ln-choice-arrow { display: none; } .ln-caption strong { font-size: 14px; } .ln-description { font-size: 12px; } .ln-phone { padding: 0 18px 18px; } .ln-film-art { height: 105px; } .ln-chat { height: 480px; padding: 18px 14px; } .ln-bubble { font-size: 11px; } }
@media (prefers-reduced-motion: reduce) { .ln-bubble, .ln-typing i { animation: none; } }
</style>
