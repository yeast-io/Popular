<script setup lang="ts">
import { computed } from 'vue';
import { useAgentSession } from './agent-session.composable';
import { provideAgentContext } from './agent-context.composable';
import { provideAgentClient } from './transport/agent-client.composable';
import type { AgentRootProps, AgentPage } from './transport/agent-transport.types';
import AgentIcon from './components/AgentIcon.vue';
import OverviewPage from './features/overview/OverviewPage.vue';
import ResourceSitesPage from './features/resource-sites/ResourceSitesPage.vue';
import DownloadersPage from './features/downloaders/DownloadersPage.vue';
import TasksPage from './features/tasks/TasksPage.vue';
import SettingsPage from './features/settings/SettingsPage.vue';
import logo from '../../../../web/public/favicon.svg';

const props = defineProps<AgentRootProps>();
const session = useAgentSession(props.client, props.host);
provideAgentContext(session);
provideAgentClient(props.client);
const {
  t,
  page,
  form,
  navigate,
  chooseLocale,
  signOut,
  loaded,
  busy,
  loadError,
  initialize,
  runtime,
  runtimeFailed,
  refreshRuntime,
  settingsError,
  text,
  dirty,
  dirtySites,
  dirtyGateway,
  dirtyDownloader,
} = session;
const pages: AgentPage[] = ['overview', 'resource-sites', 'downloaders', 'tasks', 'settings'];
const labels = computed(() => ({
  'overview': t.value.navOverview,
  'resource-sites': t.value.navResourceSites,
  'downloaders': t.value.navDownloaders,
  'tasks': t.value.navTasks,
  'settings': t.value.navSettings,
}));
const descriptions = computed(() => ({
  'overview': t.value.overviewDescription,
  'resource-sites': t.value.resourceSitesDescription,
  'downloaders': t.value.downloadersDescription,
  'tasks': t.value.tasksDescription,
  'settings': t.value.settingsDescription,
}));
</script>
<template>
  <div class="agent-shell">
    <aside class="agent-sidebar">
      <a class="agent-brand" href="#overview" @click.prevent="navigate('overview')"
        ><img :src="logo" alt="" /><span
          ><strong>{{ t.agentName }}</strong></span
        ></a
      >
      <p class="sidebar-caption">{{ t.workspace }}</p>
      <nav :aria-label="t.navigation">
        <button
          v-for="item in pages"
          :key="item"
          type="button"
          :data-page="item"
          :class="{ selected: page === item }"
          :aria-current="page === item ? 'page' : undefined"
          @click="navigate(item)"
        >
          <AgentIcon :name="item" /><span>{{ labels[item] }}</span>
        </button>
      </nav>
      <div class="sidebar-footer">
        <span class="sidebar-connection"
          ><span class="status-dot" :class="{ online: !runtimeFailed && runtime.service === 'online' }" />{{
            runtimeFailed ? t.statusUnknown : text(runtime.service)
          }}</span
        ><button type="button" class="version-button" @click="navigate('settings')">
          {{ t.version }} {{ host.version }}
        </button>
      </div>
    </aside>
    <div class="agent-workspace">
      <header class="workspace-header">
        <span class="workspace-breadcrumb">{{ t.agentName }} <span>/</span> {{ labels[page] }}</span
        ><select
          class="language-control"
          :aria-label="t.language"
          :value="form.locale"
          :disabled="busy || !loaded || session.savingLocale.value"
          @change="chooseLocale(($event.target as HTMLSelectElement).value as typeof form.locale)"
        >
          <option value="zh-CN">{{ t.chineseLanguage }}</option>
          <option value="en-US">{{ t.englishLanguage }}</option>
        </select>
        <button v-if="host.signOut" type="button" class="quiet sign-out-button" @click="signOut" :disabled="busy">
          {{ t.managementSignOut }}
        </button>
      </header>
      <main class="workspace-main" :aria-busy="!loaded && busy">
        <div class="page-heading">
          <h1 tabindex="-1">{{ labels[page] }}</h1>
          <p>{{ descriptions[page] }}</p>
        </div>
        <section v-if="loadError" class="load-failure" role="alert">
          <h2>{{ t.loadSettingsFailed }}</h2>
          <p>{{ text(settingsError) }}</p>
          <button type="button" class="primary" :disabled="busy" @click="initialize">{{ t.retry }}</button>
        </section>
        <div v-else-if="!loaded" class="loading-state" role="status">
          <span class="loading-spinner" />{{ t.loadingSettings }}
        </div>
        <template v-else>
          <div v-if="runtimeFailed" class="notice warning-notice" role="status">
            <span>{{ t.statusReadError }}</span
            ><button type="button" class="text-action" @click="refreshRuntime()">{{ t.retry }}</button>
          </div>
          <div v-if="dirty" class="notice draft-notice" role="status">
            <span>{{ t.unsavedChanges }}</span
            ><button
              v-if="dirtyGateway && page !== 'settings'"
              type="button"
              class="text-action"
              @click="navigate('settings')"
            >
              {{ t.unsavedGateway }}</button
            ><button
              v-if="dirtyDownloader && page !== 'downloaders'"
              type="button"
              class="text-action"
              @click="navigate('downloaders')"
            >
              {{ t.unsavedDownloader }}</button
            ><button
              v-if="dirtySites && page !== 'resource-sites'"
              type="button"
              class="text-action"
              @click="navigate('resource-sites')"
            >
              {{ t.unsavedSites }}
            </button>
          </div>
          <p v-if="settingsError || runtime.preferenceError" class="notice error" role="alert">
            {{ text(settingsError || runtime.preferenceError || 'unknownError') }}
          </p>
          <OverviewPage v-if="page === 'overview'" /><ResourceSitesPage
            v-else-if="page === 'resource-sites'"
          /><DownloadersPage v-else-if="page === 'downloaders'" /><TasksPage
            v-else-if="page === 'tasks'"
            :locale="form.locale"
          /><SettingsPage v-else />
        </template>
      </main>
      <footer class="workspace-footer">
        <AgentIcon name="shield" /><span>{{ t.privacyNote }}</span>
      </footer>
    </div>
  </div>
</template>
