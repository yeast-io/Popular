<script setup lang="ts">
import type { PublicConfig } from '@movie-hub/contract';
import { computed, onMounted, ref, watch } from 'vue';
import { loadWebConfig } from './config/env';
import MovieBrowser from './features/movies/MovieBrowser.vue';
import LandingPage from './features/landing/LandingPage.vue';
import LinkAgentPage from './features/link-agent/LinkAgentPage.vue';
import TvShowBrowser from './features/tv-shows/TvShowBrowser.vue';
import TvShowDetail from './features/tv-shows/TvShowDetail.vue';
import ViewingPreferencesPage from './features/viewing-preferences/ViewingPreferencesPage.vue';
import ResourceNotificationPage from './features/resource-notifications/ResourceNotificationPage.vue';
import WatchlistPage from './features/watchlist/WatchlistPage.vue';
import MovieDetail from './features/movies/MovieDetail.vue';
import { useI18n } from './i18n';
import SettingsNavigation from './features/settings/SettingsNavigation.vue';
import SettingsIcon from './features/settings/SettingsIcon.vue';
import PreferenceSettings from './features/settings/PreferenceSettings.vue';
import TelegramSettings from './features/integrations/TelegramSettings.vue';
import WhatsAppSettings from './features/integrations/WhatsAppSettings.vue';
import NotificationTestPage from './features/notifications/NotificationTestPage.vue';
import AiProviderSettings from './features/integrations/AiProviderSettings.vue';
import ResourceSiteSettings from './features/integrations/ResourceSiteSettings.vue';
import MTeamSettings from './features/integrations/MTeamSettings.vue';
import RemoteClientSettings from './features/remote-clients/RemoteClientSettings.vue';
import DownloaderSettings from './features/integrations/DownloaderSettings.vue';
import UsageStatistics from './features/usage/UsageStatistics.vue';
import AiChat from './features/ai/AiChat.vue';
import { useAuthentication } from './features/authentication/authentication.composable';
import AuthenticationPage from './features/authentication/AuthenticationPage.vue';
import { useAccountSettings } from './features/account/account-settings.composable';
import AccountSettings from './features/account/AccountSettings.vue';
import { useNavigation } from './navigation/navigation.composable';
import SiteHeader from './navigation/SiteHeader.vue';
import { usePageScroll } from './scroll/page-scroll.composable';
import ScrollControls from './scroll/ScrollControls.vue';

const { apiBaseUrl } = loadWebConfig();
const { t } = useI18n();
const notificationTestEnabled = ref(false);
const aiAssistantEnabled = ref(false);
const downloaderSettings = ref<InstanceType<typeof DownloaderSettings>>();
const scroll = usePageScroll();
const authentication = useAuthentication({ onAuthenticated: () => navigation.navigateToPath('/', true) });
const { user, loading } = authentication;
const account = useAccountSettings({ user, onUserUpdated: authentication.updateUser });
const navigation = useNavigation({
  isAuthenticated: () => Boolean(user.value),
  aiEnabled: () => aiAssistantEnabled.value,
  notificationTestEnabled: () => notificationTestEnabled.value,
  scroll,
  onAuthRequested: authentication.resetForm,
  onPageChanged: (page) => {
    authentication.clearFeedback();
    account.clearFeedback();
    if (page === 'login' || page === 'register') authentication.syncMode(page);
  },
});
const { currentPage, selectedMovieId, selectedTvShowId, settingsSection, settingsVisited, settingsSections,
  tvDetailBackLabel, scrollControlsEnabled, selectSettingsSection, selectMobileSettings, openAISettings,
  openMovie, openTvShow, backFromMovieDetail, backFromTvShowDetail, navigate, openAuth, navigateToPath } = navigation;
const avatarUrl = computed(() => user.value?.avatarUrl ? account.resolveApiUrl(user.value.avatarUrl) : '');
watch(() => user.value?.id, navigation.resetAccountNavigation, { flush: 'sync' });

onMounted(async () => {
  void loadPublicConfig();
  await authentication.restoreSession();
  if (user.value) {
    if (['home', 'login', 'register'].includes(currentPage.value)) navigateToPath('/', true);
  } else if (['settings', 'usage', 'viewing-preferences', 'watchlist', 'resource-notifications', 'ai', 'notification-tests'].includes(currentPage.value)) {
    openAuth('login', true);
  }
});

async function logout() {
  if (await authentication.logout()) navigateToPath('/');
}

async function loadPublicConfig() {
  try {
    const response = await fetch(`${apiBaseUrl}/config`);
    if (response.ok) {
      const config = (await response.json()) as PublicConfig;
      account.setAvatarLimits(config.avatar);
      notificationTestEnabled.value = config.notificationTestEnabled === true;
      aiAssistantEnabled.value = config.aiAssistantEnabled === true;
    }
  } catch {
    // Features stay hidden when public configuration is unavailable.
  } finally {
    if (!aiAssistantEnabled.value && currentPage.value === 'ai') navigateToPath('/', true);
    if (!notificationTestEnabled.value && currentPage.value === 'notification-tests') navigateToPath('/', true);
  }
}
</script>

<template>
  <main class="app-shell" :class="{ 'landing-shell': currentPage === 'home' || currentPage === 'link-agent' }">
    <div v-if="currentPage === 'home' && loading" class="loading" role="status">{{ t('status.checkingAuthentication') }}</div>
    <LandingPage v-if="currentPage === 'home' && !loading" :ai-enabled="aiAssistantEnabled"
      @register="openAuth('register')" @login="openAuth('login')" @browse="navigate('movies')" @agent="navigate('link-agent')" />
    <LinkAgentPage v-if="currentPage === 'link-agent'" @home="navigate('home')" @login="openAuth('login')" />
    <SiteHeader v-if="currentPage !== 'home' && currentPage !== 'link-agent'" :navigation="navigation"
      :user="user" :loading="loading" :ai-assistant-enabled="aiAssistantEnabled"
      :notification-test-enabled="notificationTestEnabled" :avatar-url="avatarUrl" @logout="logout" />

    <KeepAlive :max="2">
      <MovieBrowser
        v-if="currentPage === 'movies'"
        :key="user?.id ?? 'anonymous'"
        :authenticated="Boolean(user)"
        @require-login="openAuth('login')"
        @open-movie="openMovie"
      />
    </KeepAlive>
    <KeepAlive :max="1">
      <TvShowBrowser v-if="currentPage === 'tv-shows'" :key="user?.id ?? 'anonymous'" :authenticated="Boolean(user)" @require-login="openAuth('login')" @open-tv-show="openTvShow" />
    </KeepAlive>
    <KeepAlive :max="2">
      <ViewingPreferencesPage v-if="currentPage === 'viewing-preferences' && user" :key="user.id" @open-movie="openMovie" @open-tv-show="openTvShow" />
    </KeepAlive>
    <KeepAlive :max="1">
      <WatchlistPage v-if="currentPage === 'watchlist' && user" :key="user.id" @open-movie="openMovie" @open-tv-show="openTvShow" />
    </KeepAlive>
    <ResourceNotificationPage v-if="currentPage === 'resource-notifications' && user" :key="user.id" @open-movie="openMovie" @open-tv-show="openTvShow" />
    <TvShowDetail :back-label="tvDetailBackLabel" :authenticated="Boolean(user)" @require-login="openAuth('login')" v-if="currentPage === 'tv-show-detail' && selectedTvShowId" :tmdb-id="selectedTvShowId" @back="backFromTvShowDetail" />
    <MovieDetail
      v-if="currentPage === 'movie-detail' && selectedMovieId"
      :tmdb-id="selectedMovieId"
      :authenticated="Boolean(user)"
      @back="backFromMovieDetail"
      @require-login="openAuth('login')"
    />
    <NotificationTestPage
      v-if="currentPage === 'notification-tests' && user && notificationTestEnabled"
      :key="user.id"
    />
    <UsageStatistics v-if="currentPage === 'usage' && user" />
    <AiChat v-if="currentPage === 'ai' && user && aiAssistantEnabled" :key="user.id" @open-settings="openAISettings" />

    <AuthenticationPage v-if="currentPage === 'login' || currentPage === 'register'" :authentication="authentication"
      @back="navigate(user ? 'movies' : 'home')" @open-auth="openAuth($event, true)" />

    <section v-if="currentPage === 'settings' && (loading || user)" class="settings-page">
      <div class="page-toolbar">
        <button class="back-button" type="button" @click="navigate('movies')">{{ t('actions.backHome') }}</button>
      </div>
      <div v-if="loading" class="loading">{{ t('status.checkingAuthentication') }}</div>
      <template v-else-if="user">
        <div class="settings-heading">
          <p class="eyebrow">{{ t('account.eyebrow') }}</p>
          <h1>{{ t('account.settingsTitle') }}</h1>
          <p>{{ t('account.settingsDescription') }}</p>
        </div>
        <div class="settings-layout">
          <SettingsNavigation :section="settingsSection" :sections="settingsSections"
            @select="selectSettingsSection" @select-mobile="selectMobileSettings" />
          <div class="settings-content">
            <div class="settings-content-heading">
              <span class="settings-section-icon"><SettingsIcon :name="settingsSection" /></span>
              <div>
                <h2>{{ t(`settings.${settingsSection}`) }}</h2>
                <p>{{ t(`settings.${settingsSection}Description`) }}</p>
              </div>
              <button v-if="settingsSection === 'downloads'" class="settings-add-downloader" type="button"
                :aria-label="t('downloader.add')" :title="t('downloader.add')"
                @click="downloaderSettings?.openAddDialog()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>
            <AccountSettings :account="account" :user="user" :section="settingsSection" />

            <div v-if="settingsVisited.has('ai')" v-show="settingsSection === 'ai'" class="settings-form">
              <AiProviderSettings v-for="provider in (['openai', 'deepseek', 'claude'] as const)" :key="`${user.id}:${provider}`" :provider="provider" />
            </div>
            <div v-if="settingsVisited.has('resources')" v-show="settingsSection === 'resources'" class="settings-form">
              <MTeamSettings :key="user.id" />
              <ResourceSiteSettings :key="`resource-sites-hdarea-${user.id}`" />
              <ResourceSiteSettings :key="`resource-sites-hdwing-${user.id}`" site="hdwing" name="HDWing" />
            </div>
            <div v-if="settingsVisited.has('downloads')" v-show="settingsSection === 'downloads'" class="settings-form">
              <DownloaderSettings :key="user.id" ref="downloaderSettings" />
            </div>
            <div v-if="settingsVisited.has('keys')" v-show="settingsSection === 'keys'" class="settings-form">
              <RemoteClientSettings :key="user.id" />
            </div>
            <div
              v-if="settingsVisited.has('preferences')"
              v-show="settingsSection === 'preferences'"
              class="settings-form"
            >
              <PreferenceSettings :key="user.id" />
            </div>
            <div
              v-if="settingsVisited.has('notifications')"
              v-show="settingsSection === 'notifications'"
              class="settings-form"
            >
              <TelegramSettings :key="user.id" />
              <WhatsAppSettings v-if="settingsSection === 'notifications'" :key="user.id" />
            </div>
          </div>
        </div>
      </template>
    </section>

    <ScrollControls :scroll="scroll" :enabled="scrollControlsEnabled" />
  </main>
</template>
