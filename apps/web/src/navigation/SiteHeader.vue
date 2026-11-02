<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import BrandLogo from '../features/branding/BrandLogo.vue';
import { useI18n } from '../i18n';
import type { SiteHeaderProps } from './navigation.types';

const props = defineProps<SiteHeaderProps>();
const emit = defineEmits<{ logout: [] }>();
const { t } = useI18n();
const accountMenu = ref<HTMLDetailsElement | null>(null);
const { currentPage, navigate, openAuth } = props.navigation;
onMounted(() => document.addEventListener('pointerdown', closeMenusOnOutside));
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeMenusOnOutside));
function logout() {
  accountMenu.value?.removeAttribute('open');
  emit('logout');
}
function navigateFromAccount(page: 'settings' | 'usage' | 'notification-tests' | 'watchlist' | 'resource-notifications' | 'viewing-preferences') {
  accountMenu.value?.removeAttribute('open');
  navigate(page);
}

function closeMenusOnOutside(event: PointerEvent) {
  if (!(event.target instanceof Node)) return;
  for (const menu of [accountMenu.value]) {
    if (menu?.open && !menu.contains(event.target)) menu.removeAttribute('open');
  }
}

function closeAccountMenu() {
  const menu = accountMenu.value;
  if (!menu?.open) return;
  menu.removeAttribute('open');
  menu.querySelector<HTMLElement>('summary')?.focus();
}
</script>

<template>
  <header class="site-header" :class="{ 'site-header-glass': user }">
    <button class="brand brand-button" type="button" aria-label="Popular" @click="navigate(user ? 'movies' : 'home')">
      <BrandLogo />
    </button>
    <nav class="site-nav" :aria-label="t('nav.ariaLabel')">
      <div id="header-media-search" class="header-media-search"></div>
      <button type="button" :class="{ active: currentPage === 'movies' || currentPage === 'movie-detail' }" :aria-current="currentPage === 'movies' || currentPage === 'movie-detail' ? 'page' : undefined" @click="navigate('movies')">
        {{ t('nav.movies') }}
      </button>
      <button type="button" :class="{ active: currentPage === 'tv-shows' || currentPage === 'tv-show-detail' }" :aria-current="currentPage === 'tv-shows' || currentPage === 'tv-show-detail' ? 'page' : undefined" @click="navigate('tv-shows')">
        {{ t('nav.tvShows') }}
      </button>
      <button
        v-if="user && aiAssistantEnabled"
        type="button"
        :class="{ active: currentPage === 'ai' }"
        @click="navigate('ai')"
      >
        {{ t('nav.ai') }}
      </button>
      <details v-if="user" ref="accountMenu" class="account-menu" @keydown.esc.prevent="closeAccountMenu">
        <summary class="account-trigger" :aria-label="t('a11y.accountMenu')">
          <span class="nav-avatar"
            ><img
              v-if="user.avatarUrl"
              :src="avatarUrl"
              :alt="t('a11y.currentAvatar', { name: user.displayName })"
            /><span v-else>{{ user.displayName.slice(0, 1).toUpperCase() }}</span></span
          >
          <span class="account-tooltip" role="tooltip">{{ user.displayName }}</span>
        </summary>
        <div class="account-options">
          <div class="account-identity">
            <span class="nav-avatar menu-avatar"
              ><img v-if="user.avatarUrl" :src="avatarUrl" alt="" /><span v-else>{{
                user.displayName.slice(0, 1).toUpperCase()
              }}</span></span
            >
            <span class="account-identity-copy"
              ><strong>{{ user.displayName }}</strong
              ><small>{{ user.email }}</small></span
            >
          </div>
          <div class="account-action-group">
            <button
              type="button"
              :class="{ active: currentPage === 'settings' }"
              @click="navigateFromAccount('settings')"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
                <path
                  d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.07 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63a1.7 1.7 0 0 0 1-1.56V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.93 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z"
                />
              </svg>
              <span>{{ t('nav.settings') }}</span>
            </button>
            <button type="button" :class="{ active: currentPage === 'usage' }" @click="navigateFromAccount('usage')">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V9m5 10V5m5 14v-7m5 7V3" /></svg>
              <span>{{ t('nav.usage') }}</span>
            </button>
          </div>
          <div class="account-action-group account-library-group">
            <button type="button" :class="{ active: currentPage === 'watchlist' }" @click="navigateFromAccount('watchlist')">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4V3Z" /></svg>
              <span>{{ t('watchlist.title') }}</span>
            </button>
            <button type="button" :class="{ active: currentPage === 'resource-notifications' }" @click="navigateFromAccount('resource-notifications')">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
              <span>{{ t('resourceNotifications.title') }}</span>
            </button>
            <button type="button" :class="{ active: currentPage === 'viewing-preferences' }" @click="navigateFromAccount('viewing-preferences')">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 6 1 1 2-2M10 6h10M4 12l1 1 2-2M10 12h10M4 18l1 1 2-2M10 18h10" /></svg>
              <span>{{ t('viewingPreferences.title') }}</span>
            </button>
          </div>
          <div v-if="notificationTestEnabled" class="account-action-group">
            <button
              type="button"
              :class="{ active: currentPage === 'notification-tests' }"
              @click="navigateFromAccount('notification-tests')"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 3h6m-5 0v6l-6 10v2h16v-2L14 9V3M7 15h10" />
              </svg>
              <span>{{ t('notificationTest.title') }}</span>
            </button>
          </div>
          <div class="account-action-group account-signout-group">
            <button class="danger" type="button" @click="logout">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M10 17l5-5-5-5m5 5H3m11-9h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" />
              </svg>
              <span>{{ t('nav.logout') }}</span>
            </button>
          </div>
        </div>
      </details>
      <button
        v-else
        class="account-link"
        type="button"
        :disabled="loading"
        :aria-label="t('nav.loginOrRegister')"
        @click="openAuth('login')"
      >
        {{ loading ? '…' : t('nav.loginOrRegister') }}
      </button>
    </nav>
  </header>
</template>
