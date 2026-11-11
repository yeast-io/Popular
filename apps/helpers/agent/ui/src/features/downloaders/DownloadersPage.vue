<script setup lang="ts">
import { useAgentContext } from '../../agent-context.composable';
import SecretInput from '../../components/SecretInput.vue';
import { defaultPort } from './downloader-address.domain';
import qbittorrentIcon from '../../assets/qbittorrent.svg';
import transmissionIcon from '../../assets/transmission.svg';

const {
  form,
  address,
  t,
  text,
  busy,
  loaded,
  password,
  hasPassword,
  downloaderError,
  savedDownloaderUrl,
  savedProvider,
  editingDownloader,
  confirmReset,
  downloaderChanged,
  downloaderStatus,
  showDownloaderForm,
  passwordSaved,
  connectDownloader,
  resetDownloader,
  closeDownloaderEditor,
  commitAddress,
} = useAgentContext();
import documentation from '../../documentation.resources.json';

const { openDocumentation, documentationError } = useAgentContext();
</script>
<template>
  <div class="page-intro">
    <p>{{ t.downloaderIntro }}</p>
    <span class="pill neutral">{{ t.localCredentials }}</span>
  </div>
  <form novalidate @submit.prevent="connectDownloader">
    <fieldset :disabled="busy || !loaded">
      <legend>{{ t.downloader }}</legend>
      <div class="card-summary">
        <div class="summary-details">
          <p class="connection-status" role="status">
            <span
              :class="[
                'status-dot',
                { online: downloaderStatus === 'online', failed: downloaderStatus === 'unreachable' },
              ]"
            /><template v-if="form.downloaderConfigured"
              ><img
                class="tool-icon"
                :src="savedProvider === 'qbittorrent' ? qbittorrentIcon : transmissionIcon"
                alt=""
              />{{ savedProvider === 'qbittorrent' ? 'qBittorrent' : 'Transmission' }} · </template
            >{{ text(downloaderStatus) }}
          </p>
          <p v-if="savedDownloaderUrl" class="saved-address">{{ savedDownloaderUrl }}</p>
        </div>
        <div v-if="form.downloaderConfigured && !showDownloaderForm && !confirmReset" class="summary-actions">
          <button type="button" class="quiet" @click="editingDownloader = true">{{ t.editConfig }}</button>
          <button type="button" @click="confirmReset = true">{{ t.resetConfig }}</button>
        </div>
      </div>
      <template v-if="showDownloaderForm">
        <div class="provider-options" role="radiogroup" :aria-label="t.provider">
          <label class="provider-option" :class="{ selected: form.provider === 'qbittorrent' }">
            <input v-model="form.provider" type="radio" name="downloader" value="qbittorrent" />
            <img :src="qbittorrentIcon" alt="" />
            <span>qBittorrent</span>
          </label>
          <label class="provider-option" :class="{ selected: form.provider === 'transmission' }">
            <input v-model="form.provider" type="radio" name="downloader" value="transmission" />
            <img :src="transmissionIcon" alt="" />
            <span>Transmission</span>
          </label>
        </div>
        <div class="downloader-address">
          <div class="address-field">
            <label for="downloader-host">{{ t.downloaderHost }}</label>
            <div class="address-input">
              <select v-model="address.protocol" :aria-label="t.protocol">
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
              </select>
              <span class="protocol-divider" aria-hidden="true">://</span>
              <input
                id="downloader-host"
                v-model="address.host"
                required
                type="text"
                maxlength="2048"
                placeholder="127.0.0.1"
                autocapitalize="off"
                spellcheck="false"
                @change="commitAddress"
              />
            </div>
          </div>
          <label
            >{{ t.port }}
            <input
              v-model="address.port"
              type="text"
              inputmode="numeric"
              maxlength="5"
              :placeholder="defaultPort(form.provider)"
            />
          </label>
        </div>
        <p class="hint">{{ form.provider === 'qbittorrent' ? t.qbHint : t.transmissionHint }}</p>
        <div class="credentials">
          <label v-if="form.provider === 'qbittorrent'"
            >{{ t.authMode }}
            <select v-model="form.authMode">
              <option value="password">{{ t.passwordAuth }}</option>
              <option value="apiKey">{{ t.apiKeyAuth }}</option>
            </select>
          </label>
          <label v-if="form.authMode === 'password'"
            >{{ t.username
            }}<input
              v-model="form.username"
              maxlength="512"
              autocomplete="username"
              autocapitalize="off"
              spellcheck="false"
          /></label>
          <label
            >{{ form.authMode === 'apiKey' ? t.downloaderApiKey : t.password
            }}<SecretInput
              v-model="password"
              :saved="passwordSaved"
              :placeholder="
                passwordSaved ? t.keepSecret : form.authMode === 'apiKey' ? t.apiKeyPlaceholder : t.newSecret
              "
          /></label>
        </div>
        <p v-if="form.authMode === 'apiKey'" class="hint">{{ t.apiKeyHint }}</p>
        <p v-if="hasPassword && downloaderChanged" class="hint">{{ t.targetHint }}</p>
      </template>
      <div v-if="confirmReset" class="reset-confirmation" role="alert">
        <p class="hint">{{ t.resetHint }}</p>
        <div class="section-actions">
          <button type="button" class="danger" @click="resetDownloader">{{ t.confirmReset }}</button
          ><button type="button" @click="confirmReset = false">{{ t.cancel }}</button>
        </div>
      </div>
      <div v-else-if="showDownloaderForm" class="section-actions">
        <button v-if="showDownloaderForm" type="submit" class="primary" :disabled="busy">
          {{ busy ? t.busy : t.connect }}
        </button>
        <button v-if="form.downloaderConfigured" type="button" @click="confirmReset = true">{{ t.resetConfig }}</button>
        <button v-if="editingDownloader" type="button" class="quiet" @click="closeDownloaderEditor">
          {{ t.cancel }}
        </button>
      </div>
      <p v-if="downloaderError" class="error" role="alert">{{ text(downloaderError) }}</p>
    </fieldset>
  </form>
  <aside class="help-card">
    <h3>{{ t.webAccessHelp }}</h3>
    <p>{{ t.webAccessInstructions }}</p>
    <div class="documentation-links">
      <a :href="documentation.qbittorrent" @click="openDocumentation($event, 'qbittorrent')"
        >{{ t.qbittorrentDocs }} ↗</a
      ><a :href="documentation.transmission" @click="openDocumentation($event, 'transmission')"
        >{{ t.transmissionDocs }} ↗</a
      >
    </div>
    <p v-if="documentationError" class="error" role="alert">{{ t.documentationError }}</p>
  </aside>
</template>
