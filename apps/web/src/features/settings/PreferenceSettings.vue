<script setup lang="ts">
import { onMounted, onBeforeUnmount, nextTick, ref, computed } from 'vue';
import type { TasteProfileResponse, TasteRevision, OpenAIConfiguration } from '@movie-hub/contract';
import { loadWebConfig } from '../../config/env';
import { useI18n, formatDate } from '../../i18n';
import { localizedApiError, localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';

const { apiBaseUrl } = loadWebConfig();
const { t, locale } = useI18n();
const profile = ref<TasteProfileResponse | null>(null);
const drafts = ref<Record<string, string>>({});
const expandedEntries = ref<string[]>([]);
let entryExpansionInitialized = false;
const busy = ref(false);
const error = ref('');
const aiConfig = ref<OpenAIConfiguration | null>(null);
const checkingAi = ref(true);
const aiConfigError = ref('');
const aiReady = computed(() => Boolean(aiConfig.value?.configured && aiConfig.value.validation?.status === 'valid' && aiConfig.value.model));
const aiNotice = computed(() => checkingAi.value
  ? t('preferences.aiChecking')
  : aiConfigError.value || (!aiReady.value ? t('preferences.aiRequired') : ''));
let aiSequence = 0;
async function loadAIConfiguration(): Promise<boolean> {
  const id = ++aiSequence;
  checkingAi.value = true;
  aiConfigError.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/integrations/openai`, {
      credentials: 'include', headers: { 'accept-language': locale.value },
    });
    if (!response.ok) throw await localizedResponseError(response, 'preferences.aiUnavailable');
    const config = await response.json() as OpenAIConfiguration;
    if (stopped || id !== aiSequence) return false;
    aiConfig.value = config;
    return aiReady.value;
  } catch (cause) {
    if (!stopped && id === aiSequence) {
      aiConfig.value = null;
      aiConfigError.value = localizedErrorMessage(cause, 'preferences.aiUnavailable');
    }
    return false;
  } finally {
    if (!stopped && id === aiSequence) checkingAi.value = false;
  }
}

const confirmClear = ref(false);
const removeId = ref<string | null>(null);
const versionDialog = ref<HTMLDialogElement | null>(null);
const selectedRevision = ref<TasteRevision | null>(null);
let versionTrigger: HTMLElement | null = null;
function entryNumber(section: 'explicit' | 'inferred', index: number) {
  const offset = section === 'inferred'
    ? profile.value?.entries.filter((entry) => {
      return entry.section === 'explicit';
    }).length ?? 0
    : 0;
  return offset + index + 1;
}
function toggleEntry(id: string) {
  expandedEntries.value = expandedEntries.value.includes(id)
    ? expandedEntries.value.filter((entryId) => entryId !== id)
    : [...expandedEntries.value, id];
}
async function openVersion(revision: TasteRevision, event: MouseEvent) {
  versionTrigger = event.currentTarget as HTMLElement;
  selectedRevision.value = revision;
  await nextTick();
  versionDialog.value?.showModal();
}
function closeVersion() {
  versionDialog.value?.close();
}
function onVersionClosed() {
  selectedRevision.value = null;
  if (!stopped && versionTrigger?.isConnected) versionTrigger.focus();
  versionTrigger = null;
}
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
let sequence = 0;
async function request(method = 'GET', action?: Record<string, unknown>, generate = false) {
  if (generate && (busy.value || checkingAi.value || !aiReady.value)) return;
  const id = ++sequence;
  if (method !== 'GET' && timer) clearTimeout(timer);
  if (method !== 'GET') busy.value = true;
  error.value = '';
  try {
    if (generate && !(await loadAIConfiguration())) return;
    const response = await fetch(`${apiBaseUrl}/me/preferences${generate ? '/generate' : ''}`, {
      method,
      credentials: 'include',
      headers: { 'accept-language': locale.value, ...(action ? { 'content-type': 'application/json' } : {}) },
      ...(action
        ? {
            body: JSON.stringify({ expectedVersion: profile.value?.version ?? 0, ...action }),
          }
        : {}),
    });
    if (!response.ok) {
      const result = await response.json();
      if (stopped || id !== sequence) return;
      if (generate && result.error?.code === 'OPENAI_NOT_CONFIGURED') {
        aiConfig.value = { configured: false };
        return;
      }
      if (result.error?.code === 'INSUFFICIENT_MOVIE_RATINGS') {
        error.value = t('preferences.insufficient', { minimum: profile.value?.minimumRatings ?? 5 });
        return;
      }
      if (result.error?.code === 'PREFERENCE_VERSION_CONFLICT' || response.status === 409)
        throw localizedApiError({ error: { code: 'PREFERENCE_VERSION_CONFLICT' } });
      throw localizedApiError(result, 'preferences.failed');
    }
    const result = (await response.json()) as TasteProfileResponse;
    if (stopped || id !== sequence) return;
    profile.value = result;
    if (!entryExpansionInitialized && result.entries.length) {
      const first = result.entries.find((entry) => entry.section === 'explicit') ?? result.entries[0]!;
      expandedEntries.value = [first.id];
      entryExpansionInitialized = true;
    } else expandedEntries.value = expandedEntries.value.filter((id) => {
      return result.entries.some((entry) => entry.id === id);
    });
    for (const entry of result.entries)
      if (drafts.value[entry.id] === undefined || method !== 'GET') drafts.value[entry.id] = entry.content;
    confirmClear.value = false;
    removeId.value = null;
    if (timer) clearTimeout(timer);
    if (result.task && ['pending', 'processing'].includes(result.task.status))
      timer = setTimeout(() => {
        void request();
      }, 3000);
  } catch (cause) {
    if (!stopped && id === sequence) error.value = localizedErrorMessage(cause, 'preferences.failed');
  } finally {
    if (id === sequence) busy.value = false;
  }
}
onMounted(() => {
  void loadAIConfiguration();
  void request();
});
onBeforeUnmount(() => {
  stopped = true;
  closeVersion();
  sequence++;
  aiSequence++;
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <section class="settings-card preference-settings" :aria-busy="busy || checkingAi">
    <p v-if="aiNotice" class="preference-notice" :class="{ error: !checkingAi }" :role="checkingAi ? 'status' : 'alert'">{{ aiNotice }}</p>
    <p v-if="error" class="preference-notice error" role="alert">{{ error }}</p>
    <p v-if="!profile && !error" class="preference-muted" role="status">{{ t('preferences.loading') }}</p>
    <template v-if="profile">
      <section class="preference-generation" :aria-label="t('preferences.analysis')">
        <div class="preference-generation-copy">
          <p class="preference-summary">
            <span>{{ t('preferences.ratings', { count: profile.ratedCount }) }}</span>
            <span v-if="profile.generatedAt" class="preference-muted">
              · {{ t('preferences.generatedAt', { time: formatDate(profile.generatedAt) }) }}</span
            >
          </p>
          <p v-if="!profile.generatedAt && profile.ratedCount < profile.minimumRatings" class="preference-muted">
            {{ t('preferences.insufficient', { minimum: profile.minimumRatings }) }}
          </p>
        </div>
        <button
          type="button"
          class="primary"
          :disabled="
            busy || checkingAi || !aiReady ||
            (!profile.generatedAt && profile.ratedCount < profile.minimumRatings) ||
            ['pending', 'processing'].includes(profile.task?.status ?? '')
          "
          @click="request('POST', undefined, true)"
        >
          {{
            t(
              profile.task?.status === 'failed' && aiReady
                ? 'preferences.retry'
                : profile.generatedAt
                  ? 'preferences.regenerate'
                  : 'preferences.generate',
            )
          }}
        </button>
      </section>
      <div
        v-if="profile.marksChanged || ['pending', 'processing'].includes(profile.task?.status ?? '')"
        class="preference-status"
        role="status"
        aria-live="polite"
      >
        <span v-if="profile.marksChanged">{{ t('preferences.changed') }}</span>
        <span v-if="profile.task && ['pending', 'processing'].includes(profile.task.status)" class="preference-badge">{{
          t(`preferences.${profile.task.status}`)
        }}</span>
      </div>
      <p v-if="profile.task?.status === 'failed' && aiReady && !checkingAi" class="preference-notice error" role="alert">
        {{ t('preferences.taskFailed') }}
      </p>
      <p class="preference-hint">{{ t('preferences.manualHint') }}</p>

      <label class="preference-toggle" for="preference-chat-maintenance">
        <span class="preference-toggle-copy">
          <strong id="preference-chat-label">{{ t('preferences.autoMaintain') }}</strong>
          <span id="preference-chat-hint">{{ t('preferences.chatHint') }}</span>
        </span>
        <span class="preference-switch">
          <input
            id="preference-chat-maintenance"
            type="checkbox"
            role="switch"
            aria-labelledby="preference-chat-label"
            aria-describedby="preference-chat-hint"
            :checked="profile.autoMaintain"
            :disabled="busy"
            @change="request('PATCH', { autoMaintain: ($event.target as HTMLInputElement).checked })"
          />
          <span class="preference-switch-track" aria-hidden="true"></span>
        </span>
      </label>

      <div v-if="!profile.entries.length" class="preference-empty">
        <h3>{{ t('preferences.emptyTitle') }}</h3>
        <p>{{ t('preferences.empty') }}</p>
      </div>
      <template v-else>
        <section
          v-for="section in ['explicit', 'inferred'] as const"
          v-show="profile.entries.some((item) => item.section === section)"
          :key="section"
          class="preference-group"
        >
          <h3>
            {{ t(`preferences.${section}`) }}
            <span class="preference-count">{{
              t('preferences.entryCount', { count: profile.entries.filter((item) => item.section === section).length })
            }}</span>
          </h3>
          <p v-if="section === 'inferred'" class="preference-inference-hint">{{ t('preferences.inferenceHint') }}</p>
          <article
            v-for="(entry, index) in profile.entries.filter((item) => item.section === section)"
            :key="entry.id"
            class="preference-entry"
            :class="{ 'is-expanded': expandedEntries.includes(entry.id) }"
          >
            <button
              type="button" class="preference-entry-summary"
              :aria-expanded="expandedEntries.includes(entry.id)"
              :aria-controls="`preference-entry-panel-${entry.id}`"
              @click="toggleEntry(entry.id)"
            >
              <span class="sr-only">{{ t('preferences.entryLabel', { number: entryNumber(section, index) }) }}</span>
              <span class="preference-entry-number" aria-hidden="true">{{ entryNumber(section, index) }}</span>
              <span class="preference-entry-preview" :aria-hidden="expandedEntries.includes(entry.id)">{{ drafts[entry.id]?.trim() || entry.content }}</span>
            </button>
            <div
              :id="`preference-entry-panel-${entry.id}`" class="preference-entry-reveal"
              :aria-hidden="!expandedEntries.includes(entry.id)" :inert="!expandedEntries.includes(entry.id)"
            >
              <div class="preference-entry-clip">
                <div class="preference-entry-content">
                  <label :for="`preference-${entry.id}`" class="preference-entry-label">
                    <span class="sr-only">{{ t('preferences.entryLabel', { number: entryNumber(section, index) }) }}</span>
                  </label>
                  <textarea :id="`preference-${entry.id}`" v-model="drafts[entry.id]" maxlength="500" rows="3" />
                  <div class="preference-entry-meta">
                    <small>{{ t('preferences.sources') }}：{{ entry.evidenceRefs.join(' · ') }}</small>
                    <small
                      >{{ formatDate(entry.updatedAt) }} · {{ t('preferences.version', { version: profile.version }) }}</small
                    >
                  </div>
                  <div class="preference-actions">
                    <button
                      class="secondary"
                      type="button"
                      :disabled="busy || !drafts[entry.id]?.trim() || drafts[entry.id] === entry.content"
                      @click="request('PATCH', { entryId: entry.id, content: drafts[entry.id] })"
                    >
                      {{ t('preferences.save') }}
                    </button>
                    <button
                      v-if="removeId !== entry.id"
                      class="secondary danger"
                      type="button"
                      :disabled="busy"
                      @click="removeId = entry.id"
                    >
                      {{ t('preferences.remove') }}
                    </button>
                    <template v-else>
                      <button
                        class="secondary danger"
                        type="button"
                        :disabled="busy"
                        @click="request('PATCH', { entryId: entry.id })"
                      >
                        {{ t('preferences.confirmRemove') }}
                      </button>
                      <button class="secondary" type="button" @click="removeId = null">{{ t('preferences.cancel') }}</button>
                    </template>
                  </div>
                </div>
              </div>
            </div>
          </article>
        </section>
      </template>
      <details v-if="profile.revisions.length" class="preference-history">
        <summary>{{ t('preferences.history') }}</summary>
        <ol class="preference-version-list">
          <li
            v-for="revision in profile.revisions.slice(-5).reverse()"
            :key="revision.version"
            class="preference-revision"
          >
            <div>
              <h4>{{ t('preferences.version', { version: revision.version }) }}</h4>
              <time :datetime="revision.at">{{ formatDate(revision.at) }}</time>
            </div>
            <button class="secondary" type="button" aria-haspopup="dialog" @click="openVersion(revision, $event)">
              {{ t('preferences.viewContent') }}
            </button>
          </li>
        </ol>
      </details>
      <footer v-if="profile.entries.length" class="settings-card-footer preference-footer">
        <p class="preference-muted">{{ t('preferences.clearDescription') }}</p>
        <div class="preference-actions">
          <button
            v-if="!confirmClear"
            class="secondary danger"
            type="button"
            :disabled="busy"
            @click="confirmClear = true"
          >
            {{ t('preferences.clear') }}
          </button>
          <template v-else>
            <p class="preference-muted">{{ t('preferences.clearHint') }}</p>
            <button class="secondary danger" type="button" :disabled="busy" @click="request('PATCH', { clear: true })">
              {{ t('preferences.confirmClear') }}
            </button>
            <button class="secondary" type="button" @click="confirmClear = false">{{ t('preferences.cancel') }}</button>
          </template>
        </div>
      </footer>
    </template>
    <Teleport to="body">
      <dialog
        ref="versionDialog"
        class="preference-version-dialog"
        aria-labelledby="preference-version-title"
        @cancel.prevent="closeVersion"
        @close="onVersionClosed"
        @click.self="closeVersion"
      >
        <template v-if="selectedRevision">
          <header class="preference-dialog-heading">
            <h2 id="preference-version-title">{{ t('preferences.version', { version: selectedRevision.version }) }}</h2>
            <time :datetime="selectedRevision.at">{{ formatDate(selectedRevision.at) }}</time>
          </header>
          <div class="preference-dialog-content" tabindex="0" role="region" :aria-label="t('preferences.content')">
            <p v-if="!selectedRevision.entries.length" class="preference-dialog-empty">
              {{ t('preferences.noContent') }}
            </p>
            <template v-for="section in ['explicit', 'inferred'] as const" :key="section">
              <section
                v-if="selectedRevision.entries.some((entry) => entry.section === section)"
                class="preference-dialog-group"
              >
                <h3>{{ t(`preferences.${section}`) }}</h3>
                <p v-for="entry in selectedRevision.entries.filter((item) => item.section === section)" :key="entry.id">
                  {{ entry.content }}
                </p>
              </section>
            </template>
          </div>
          <footer class="preference-dialog-footer">
            <button class="secondary" type="button" autofocus @click="closeVersion">
              {{ t('preferences.close') }}
            </button>
          </footer>
        </template>
      </dialog>
    </Teleport>
  </section>
</template>

<style scoped>
.preference-settings {
  min-width: 0;
}
.preference-settings p {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.65;
}
.preference-settings h3 {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
}
.preference-generation {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}
.preference-generation-copy {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.preference-generation-copy > p {
  color: #b4b5b0;
}
.preference-summary > span {
  display: inline;
}
.preference-settings .preference-inference-hint {
  margin-top: 6px;
  color: #93948f;
  font-size: 0.73rem;
}
.preference-settings .primary,
.preference-settings .secondary {
  flex-shrink: 0;
  width: auto;
  min-height: 36px;
  margin: 0;
  padding: 9px 15px;
  border-radius: 7px;
  font-size: 0.75rem;
}
.preference-settings button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.preference-settings button:focus-visible,
.preference-history summary:focus-visible {
  outline: 2px solid #ef795f;
  outline-offset: 3px;
}
.preference-settings .preference-muted,
.preference-entry-meta {
  color: #93948f;
  font-size: 0.73rem;
}
.preference-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  color: #c7b8a3;
  font-size: 0.75rem;
}
.preference-badge {
  padding: 4px 9px;
  border: 1px solid #3d463d;
  border-radius: 6px;
  background: #242c26;
  color: #b1c8b6;
  font-size: 0.7rem;
}
.preference-settings .preference-hint {
  margin-top: 16px;
  color: #93948f;
  font-size: 0.73rem;
}
.preference-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  margin: 24px 0;
  padding: 20px 0;
  border-top: 1px solid #ffffff12;
  border-bottom: 1px solid #ffffff12;
  cursor: pointer;
}
.preference-toggle-copy {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.preference-toggle-copy strong {
  color: #dddeda;
  font-size: 0.8rem;
  font-weight: 600;
}
.preference-toggle-copy > span {
  color: #93948f;
  font-size: 0.73rem;
  font-weight: 400;
  line-height: 1.6;
}
.preference-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
}
.preference-settings .preference-switch input {
  position: absolute;
  inset: 0;
  z-index: 1;
  box-sizing: border-box;
  width: 44px;
  height: 44px;
  min-height: 0;
  margin: 0;
  padding: 0;
  opacity: 0;
  cursor: pointer;
}
.preference-switch-track {
  display: block;
  width: 38px;
  height: 22px;
  border: 1px solid #ffffff24;
  border-radius: 20px;
  background: #3b3d3e;
  transition: background 0.15s;
}
.preference-switch-track::after {
  content: '';
  display: block;
  width: 16px;
  height: 16px;
  margin: 2px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s;
}
.preference-switch input:checked + .preference-switch-track {
  background: #de4e30;
  border-color: #de4e30;
}
.preference-switch input:checked + .preference-switch-track::after {
  transform: translateX(16px);
}
.preference-switch input:focus-visible + .preference-switch-track {
  outline: 2px solid #ef795f;
  outline-offset: 4px;
}
.preference-switch input:disabled {
  cursor: not-allowed;
}
.preference-switch input:disabled + .preference-switch-track {
  opacity: 0.45;
}
.preference-empty {
  display: grid;
  justify-items: center;
  gap: 10px;
  padding: 28px 20px;
  border: 0;
  background: transparent;
  text-align: center;
}
.preference-empty p {
  max-width: 420px;
  color: #93948f;
  font-size: 0.75rem;
}
.preference-group {
  margin-top: 24px;
}
.preference-group > h3 {
  display: flex;
  align-items: center;
  gap: 8px;
}
.preference-count {
  min-width: 20px;
  padding: 2px 6px;
  border-radius: 5px;
  background: #ffffff0a;
  color: #9a9c95;
  font-size: 0.68rem;
  text-align: center;
}
.preference-entry {
  display: block;
  margin-top: 12px;
  padding: 16px;
  border: 1px solid #ffffff12;
  border-radius: 9px;
  background: #11131466;
}
.preference-entry label {
  color: #b8bab3;
  font-size: 0.73rem;
}
.preference-entry-summary { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; padding: 0; border: 0; background: transparent; text-align: left; cursor: pointer; }
.preference-entry-summary::after { content: ''; flex: 0 0 6px; width: 6px; height: 6px; margin-left: auto; border-right: 1px solid #969d92; border-bottom: 1px solid #969d92; transform: rotate(45deg); transition: transform 260ms ease; }
.preference-entry.is-expanded > .preference-entry-summary::after { transform: rotate(225deg); }
.preference-entry-summary:focus-visible { outline: 2px solid #ef795f; outline-offset: 5px; border-radius: 3px; }
.preference-entry-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #c6cbc0; font-size: .8rem; line-height: 1.6; opacity: 1; visibility: visible; transform: translateY(0); transition: opacity 160ms ease, transform 240ms ease, visibility 160ms; transition-delay: 100ms; }
.preference-entry.is-expanded .preference-entry-preview { opacity: 0; visibility: hidden; transform: translateY(-3px); transition-delay: 0ms; }
.preference-entry-reveal { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows 280ms cubic-bezier(.22, .68, 0, 1), opacity 160ms ease; }
.preference-entry.is-expanded .preference-entry-reveal { grid-template-rows: 1fr; opacity: 1; transition-delay: 0ms, 80ms; }
.preference-entry-clip { min-height: 0; overflow: hidden; }
.preference-entry-content { display: grid; gap: 10px; padding-top: 12px; }
.preference-entry-label { position: absolute; }
.preference-entry-number { flex-shrink: 0; }
.preference-entry-number { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; box-sizing: border-box; border: 1px solid #efa45740; border-radius: 50%; background: #efa45718; color: #efa457; font-size: .7rem; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; }
.preference-entry textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 88px;
  resize: vertical;
  font: inherit;
  font-size: 0.8rem;
  line-height: 1.6;
  padding: 12px;
  color: #dedfd9;
  background: #111314;
  border: 1px solid #ffffff1f;
  border-radius: 7px;
}
.preference-entry textarea:focus-visible {
  outline: 2px solid #ef795f;
  outline-offset: 2px;
}
.preference-entry-meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 6px 16px;
}
.preference-entry-meta small {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 0.68rem;
  line-height: 1.6;
}
.preference-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.preference-actions .danger {
  color: #ffa18d;
  background: #ed654d12;
}
.preference-history {
  margin-top: 24px;
  color: #a4a69f;
  font-size: 0.75rem;
}
.preference-history summary {
  width: fit-content;
  padding: 8px 0;
  cursor: pointer;
}
.preference-version-list {
  display: grid;
  gap: 8px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}
.preference-revision {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 12px 14px;
  border: 1px solid #ffffff12;
  border-radius: 7px;
}
.preference-revision h4 {
  margin: 0 0 4px;
  color: #d5d7cf;
  font-size: 0.75rem;
  font-weight: 500;
}
.preference-revision time {
  color: #93948f;
  font-size: 0.7rem;
}
.preference-version-dialog {
  box-sizing: border-box;
  width: min(640px, calc(100vw - 32px));
  max-height: min(80dvh, 720px);
  padding: 0;
  overflow: hidden;
  border: 1px solid #ffffff24;
  border-radius: 12px;
  background: #181a1b;
  color: #e1e2dc;
  box-shadow: 0 24px 80px #0008;
}
.preference-version-dialog[open] {
  display: flex;
  flex-direction: column;
}
.preference-version-dialog::backdrop {
  background: #000a;
}
:global(body:has(.preference-version-dialog[open])) {
  overflow: hidden;
}
.preference-dialog-heading {
  flex-shrink: 0;
  padding: 20px 24px;
  border-bottom: 1px solid #ffffff12;
}
.preference-dialog-heading h2 {
  margin: 0 0 6px;
  font-size: 1rem;
  font-weight: 600;
}
.preference-dialog-heading time {
  color: #93948f;
  font-size: 0.73rem;
}
.preference-dialog-content {
  min-height: 0;
  padding: 24px;
  overflow-y: auto;
  overscroll-behavior: contain;
  overflow-wrap: anywhere;
}
.preference-dialog-content:focus-visible {
  outline: 2px solid #ef795f;
  outline-offset: -3px;
}
.preference-dialog-group + .preference-dialog-group {
  margin-top: 24px;
}
.preference-dialog-group h3 {
  margin: 0 0 12px;
  font-size: 0.8rem;
  font-weight: 600;
  color: #a6aaa0;
}
.preference-dialog-group p {
  margin: 0;
  padding: 12px 0;
  font-size: 0.85rem;
  line-height: 1.8;
  white-space: pre-wrap;
}
.preference-dialog-group p + p {
  border-top: 1px solid #ffffff0d;
}
.preference-dialog-empty {
  margin: 12px 0;
  color: #93948f;
  font-size: 0.85rem;
  text-align: center;
}
.preference-dialog-footer {
  display: flex;
  justify-content: flex-end;
  flex-shrink: 0;
  padding: 16px 24px;
  border-top: 1px solid #ffffff12;
}
.preference-dialog-footer .secondary {
  width: auto;
  min-height: 36px;
  margin: 0;
  padding: 9px 18px;
  border-radius: 7px;
  font-size: 0.75rem;
}
.preference-dialog-footer button:focus-visible {
  outline: 2px solid #ef795f;
  outline-offset: 3px;
}
.preference-notice {
  margin: 16px 0;
  font-size: 0.75rem;
}
.preference-settings .preference-footer {
  flex-wrap: wrap;
}
@media (max-width: 640px) {
  .preference-generation {
    align-items: flex-start;
    flex-direction: column;
    gap: 16px;
  }
  .preference-generation .primary {
    width: 100%;
  }
  .preference-toggle {
    gap: 16px;
  }
  .preference-entry {
    padding: 12px;
  }
  .preference-empty {
    padding: 24px 12px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .preference-entry-preview,
  .preference-entry-reveal,
  .preference-entry-summary::after,
  .preference-switch-track,
  .preference-switch-track::after {
    transition: none !important;
  }
}
</style>
