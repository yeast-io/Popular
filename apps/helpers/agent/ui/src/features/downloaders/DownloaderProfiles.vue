<script setup lang="ts">
import { useAgentContext } from '../../agent-context.composable';
import CapsuleSwitch from '../../components/CapsuleSwitch.vue';
import SecretInput from '../../components/SecretInput.vue';
import qbittorrentIcon from '../../assets/qbittorrent.svg';
import transmissionIcon from '../../assets/transmission.svg';

const { t, text, profiles, runtime, runtimeFailed } = useAgentContext();
const {
  entries,
  loading,
  loaded,
  error,
  editing,
  selectedId,
  removingId,
  form,
  password,
  passwordSaved,
  edit,
  cancel,
  save,
  action,
  load,
} = profiles;
</script>
<template>
  <div class="panel-heading">
    <p>{{ t.downloaderProfilesDescription }}</p>
    <button type="button" :disabled="loading || editing || !loaded" @click="edit()">{{ t.addDownloader }}</button>
  </div>
  <p v-if="error" class="error" role="alert">{{ text(error) }}</p>
  <button v-if="!loaded && error" type="button" :disabled="loading" @click="load">{{ t.retry }}</button>
  <p v-if="loading" role="status">{{ t.loadingSettings }}</p>
  <div class="local-sites-grid">
    <article v-for="row in entries" :key="row.id" class="local-site-card" :data-downloader="row.id">
      <header class="local-site-header">
        <div class="local-site-identity">
          <img class="tool-icon" :src="row.provider === 'qbittorrent' ? qbittorrentIcon : transmissionIcon" alt="" />
          <h2>{{ row.provider === 'qbittorrent' ? t.qbittorrentName : t.transmissionName }}</h2>
        </div>
        <div class="local-site-controls">
        <CapsuleSwitch
          :checked="row.enabled"
          :label="row.enabled ? t.disableDownloader : t.enableDownloader"
          :disabled="loading || editing"
          @change="action(row, 'enabled')"
        />
        <button
          type="button"
          :disabled="loading || editing || !row.enabled || row.isDefault"
          @click="action(row, 'default')"
        >
          {{ row.isDefault ? t.defaultItem : t.setDefault }}
        </button>
        </div>
      </header>
      <p class="endpoint">{{ row.downloaderUrl }}</p>
      <p role="status">
        {{
          !row.enabled
            ? t.siteDisabled
            : row.isDefault
              ? text(runtimeFailed ? 'statusUnknown' : runtime.downloader)
              : t.siteEnabled
        }}
      </p>
      <div class="summary-actions">
        <button type="button" :disabled="loading || editing" @click="edit(row)">{{ t.editConfig }}</button>
        <button type="button" :disabled="loading || editing" @click="removingId = row.id">
          {{ t.removeDownloader }}
        </button>
      </div>
      <div v-if="removingId === row.id" class="reset-confirmation" role="alert">
        <p>{{ t.removeDownloaderConfirm }}</p>
        <button type="button" class="danger" :disabled="loading" @click="action(row, 'remove')">
          {{ t.confirmReset }}
        </button>
        <button type="button" :disabled="loading" @click="removingId = null">{{ t.cancel }}</button>
      </div>
    </article>
  </div>
  <p v-if="loaded && !entries.length && !editing">{{ t.noDownloaders }}</p>
  <form v-if="editing" @submit.prevent="save">
    <fieldset :disabled="loading">
      <legend>{{ selectedId ? t.editConfig : t.addDownloader }}</legend>
      <label
        >{{ t.downloader
        }}<select v-model="form.provider">
          <option value="qbittorrent">{{ t.qbittorrentName }}</option>
          <option value="transmission">{{ t.transmissionName }}</option>
        </select></label
      >
      <label
        >{{ t.downloaderAddress }}<input v-model="form.downloaderUrl" type="text" maxlength="2048" required
      /></label>
      <label v-if="form.provider === 'qbittorrent'"
        >{{ t.authMode
        }}<select v-model="form.authMode">
          <option value="password">{{ t.passwordAuth }}</option>
          <option value="apiKey">{{ t.apiKeyAuth }}</option>
        </select></label
      >
      <label v-if="form.provider === 'transmission' || form.authMode === 'password'"
        >{{ t.username }}<input v-model="form.username" maxlength="512" autocomplete="username"
      /></label>
      <label
        >{{ form.provider === 'qbittorrent' && form.authMode === 'apiKey' ? t.downloaderApiKey : t.password
        }}<SecretInput
          v-model="password"
          :saved="!!passwordSaved"
          :placeholder="passwordSaved ? t.keepSecret : t.newSecret"
      /></label>
      <div class="section-actions">
        <button type="submit" class="primary">{{ t.connect }}</button
        ><button type="button" @click="cancel">{{ t.cancel }}</button>
      </div>
    </fieldset>
  </form>
</template>
