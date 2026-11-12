import { computed, onBeforeUnmount, onMounted, readonly, ref } from 'vue';
import { useI18n } from '../i18n';
import { settingsSectionFromSearch, settingsSectionSlug } from '../features/settings/settings-navigation.domain';
import type { NavigationOptions, Page, SettingsSection } from './navigation.types';
import { PAGE_PATHS } from './navigation.policy';

export function useNavigation(options: NavigationOptions) {
  const { t } = useI18n();
  const currentPage = ref<Page>(pageFromPath());
  const tvDetailBackLabel = computed(() => {
    const origin = window.history.state?.tvShowOrigin;
    if (origin === 'resource-notifications') return t('resourceNotifications.back');
    if (currentPage.value === 'tv-show-detail' && origin === 'viewing-preferences') return t('viewingPreferences.back');
    if (currentPage.value === 'tv-show-detail' && origin === 'watchlist') return t('watchlist.back');
    return t('actions.backTvShows');
  });
  const settingsSection = ref<SettingsSection>(settingsSectionFromSearch(window.location.search));
  const settingsVisited = ref(new Set<SettingsSection>([settingsSection.value]));
  const settingsSections = ['profile', 'language', 'ai', 'preferences', 'resources', 'downloads', 'keys', 'notifications'] as const;
  function selectSettingsSection(section: SettingsSection) {
    settingsSection.value = section;
    settingsVisited.value.add(section);
    if (currentPage.value === 'settings') {
      const url = new URL(window.location.href);
      url.searchParams.set('section', settingsSectionSlug(section));
      if (url.search !== window.location.search) window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }
  function selectMobileSettings(event: Event) {
    selectSettingsSection((event.target as HTMLSelectElement).value as SettingsSection);
  }
  function openAISettings() {
    selectSettingsSection('ai');
    navigate('settings');
  }
  const selectedMovieId = ref(movieIdFromPath());
  const selectedTvShowId = ref(tvShowIdFromPath());

  function resetAccountNavigation() {
    settingsSection.value = currentPage.value === 'settings' ? settingsSectionFromSearch(window.location.search) : 'profile';
    settingsVisited.value = new Set([settingsSection.value]);
  }

  function rememberListScroll() {
    if (['movies', 'tv-shows', 'viewing-preferences', 'watchlist', 'resource-notifications'].includes(currentPage.value)) {
      options.scroll.rememberPosition(currentPage.value);
    }
  }

  const scrollControlsEnabled = computed(() => ['movies', 'tv-shows', 'viewing-preferences', 'watchlist', 'resource-notifications', 'movie-detail', 'tv-show-detail'].includes(currentPage.value));
  onMounted(() => window.addEventListener('popstate', syncPageFromLocation));
  onBeforeUnmount(() => window.removeEventListener('popstate', syncPageFromLocation));

  function pageFromPath(): Page {
    if (window.location.pathname === '/link-agent') return 'link-agent';
    if (window.location.pathname === '/' && !options.isAuthenticated()) return 'home';
    if (movieIdFromPath()) return 'movie-detail';
    if (tvShowIdFromPath()) return 'tv-show-detail';
    if (window.location.pathname === '/tv-shows') return 'tv-shows';
    if (window.location.pathname === '/login') return 'login';
    if (window.location.pathname === '/register') return 'register';
    if (window.location.pathname === '/resource-notifications') return 'resource-notifications';
    if (window.location.pathname === '/watchlist') return 'watchlist';
    if (window.location.pathname === '/my-movies') {
      window.history.replaceState({}, '', '/viewing-preferences');
      return 'viewing-preferences';
    }
    if (window.location.pathname === '/viewing-preferences') return 'viewing-preferences';
    if (window.location.pathname === '/ai') return 'ai';
    if (window.location.pathname === '/dev/notification-tests') return 'notification-tests';
    if (window.location.pathname === '/settings') return 'settings';
    return window.location.pathname === '/usage' ? 'usage' : 'movies';
  }

  function tvShowIdFromPath(): number | null {
    const match = window.location.pathname.match(/^\/tv-shows\/([1-9]\d*)$/);
    const id = match ? Number(match[1]) : null;
    return id && Number.isSafeInteger(id) ? id : null;
  }

  function openTvShow(tmdbId: number) {
    rememberListScroll();
    window.history.pushState({ tvShowOrigin: ['watchlist', 'resource-notifications', 'viewing-preferences'].includes(currentPage.value) ? currentPage.value : 'tv-shows' }, '', `/tv-shows/${tmdbId}`);
    selectedTvShowId.value = tmdbId;
    currentPage.value = 'tv-show-detail';
    options.scroll.scrollPageTo({ top: 0, behavior: 'smooth' });
  }

  function backFromTvShowDetail() {
    if (['tv-shows', 'watchlist', 'resource-notifications', 'viewing-preferences'].includes(window.history.state?.tvShowOrigin)) window.history.back();
    else navigate('tv-shows');
  }

  function movieIdFromPath(): number | null {
    const match = window.location.pathname.match(/^\/movies\/(\d+)$/);
    return match ? Number(match[1]) : null;
  }

  function syncPageFromLocation() {
    const nextPage = pageFromPath();
    if (nextPage === 'ai' && !options.aiEnabled()) {
      navigateToPath('/', true);
      return;
    }
    if (nextPage === 'notification-tests' && !options.notificationTestEnabled()) {
      navigateToPath('/', true);
      return;
    }
    currentPage.value = nextPage;
    if (nextPage === 'settings') {
      settingsSection.value = settingsSectionFromSearch(window.location.search);
      settingsVisited.value.add(settingsSection.value);
    }
    selectedMovieId.value = movieIdFromPath();
    selectedTvShowId.value = tvShowIdFromPath();
    options.onPageChanged(currentPage.value);
    if (nextPage === 'movies' || nextPage === 'tv-shows' || nextPage === 'viewing-preferences' || nextPage === 'watchlist' || nextPage === 'resource-notifications') options.scroll.restorePosition(nextPage);
  }

  function openMovie(tmdbId: number) {
    const origin = currentPage.value;
    const movieOrigin = ['resource-notifications', 'watchlist', 'viewing-preferences'].includes(origin) ? origin : 'movies';
    rememberListScroll();
    window.history.pushState({ movieOrigin }, '', `/movies/${tmdbId}`);
    selectedMovieId.value = tmdbId;
    currentPage.value = 'movie-detail';
    options.scroll.scrollPageTo({ top: 0, behavior: 'smooth' });
  }

  function backFromMovieDetail() {
    const movieOrigin = window.history.state?.movieOrigin;
    if (movieOrigin === 'movies' || movieOrigin === 'viewing-preferences' || movieOrigin === 'watchlist' || movieOrigin === 'resource-notifications') window.history.back();
    else navigate('movies');
  }

  function navigate(page: Page) {
    if (page === 'ai' && !options.aiEnabled()) return;
    rememberListScroll();
    const path = page === 'settings'
      ? `/settings?section=${settingsSectionSlug(settingsSection.value)}`
      : (PAGE_PATHS.get(page) ?? '/movies');
    if (`${window.location.pathname}${window.location.search}` !== path) window.history.pushState({}, '', path);
    currentPage.value = page;
    options.onPageChanged(currentPage.value);
    if (page === 'movies' || page === 'tv-shows' || page === 'viewing-preferences' || page === 'watchlist' || page === 'resource-notifications') options.scroll.restorePosition(page);
    else options.scroll.scrollPageTo({ top: 0, behavior: 'smooth' });
  }

  function openAuth(nextMode: 'login' | 'register', replace = false) {
    options.onAuthRequested(nextMode);
    const path = `/${nextMode}`;
    if (replace) window.history.replaceState({}, '', path);
    else window.history.pushState({}, '', path);
    currentPage.value = nextMode;
    selectedMovieId.value = null;
    options.onPageChanged(currentPage.value);
    options.scroll.scrollPageTo({ top: 0, behavior: 'smooth' });
  }

  function navigateToPath(path: string, replace = false) {
    if (replace) window.history.replaceState({}, '', path);
    else window.history.pushState({}, '', path);
    currentPage.value = pageFromPath();
    selectedMovieId.value = movieIdFromPath();
    selectedTvShowId.value = tvShowIdFromPath();
    options.onPageChanged(currentPage.value);
    options.scroll.scrollPageTo({ top: 0, behavior: 'smooth' });
  }

  return { currentPage: readonly(currentPage), selectedMovieId: readonly(selectedMovieId), selectedTvShowId: readonly(selectedTvShowId),
    settingsSection: readonly(settingsSection), settingsVisited: readonly(settingsVisited), settingsSections,
    tvDetailBackLabel, scrollControlsEnabled, selectSettingsSection, selectMobileSettings, openAISettings,
    openMovie, openTvShow, backFromMovieDetail, backFromTvShowDetail, navigate, openAuth, navigateToPath, resetAccountNavigation };
}
