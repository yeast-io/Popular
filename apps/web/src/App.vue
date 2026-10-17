<script setup lang="ts">
import type { ApiError, AuthResponse, AuthUser, LoginRequest, PublicConfig, RegisterRequest } from '@movie-hub/contract';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { loadWebConfig } from './config/env';
import MovieBrowser from './features/movies/MovieBrowser.vue';
import MyMovies from './features/movies/MyMovies.vue';
import MovieDetail from './features/movies/MovieDetail.vue';
import { useI18n } from './i18n';
import { localizedApiError, localizedErrorMessage, localizedResponseError } from './i18n/api-error';
import OpenAISettings from './features/integrations/OpenAISettings.vue';
import MTeamSettings from './features/integrations/MTeamSettings.vue';
import TransmissionSettings from './features/integrations/TransmissionSettings.vue';
import QBittorrentSettings from './features/integrations/QBittorrentSettings.vue';
import UsageStatistics from './features/usage/UsageStatistics.vue';
import AiChat from './features/ai/AiChat.vue';

const { apiBaseUrl } = loadWebConfig();
const { locale, setLocale, t } = useI18n();
const localeMenu = ref<HTMLDetailsElement | null>(null);
const accountMenu = ref<HTMLDetailsElement | null>(null);
const mode = ref<'login' | 'register'>(window.location.pathname === '/register' ? 'register' : 'login');
const email = ref('');
const password = ref('');
const displayName = ref('');
const user = ref<AuthUser | null>(null);
const loading = ref(true);
const submitting = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
const profileName = ref('');
const avatarFile = ref<File | null>(null);
const avatarRemoved = ref(false);
const avatarPreview = ref('');
const avatarLimits = ref<PublicConfig['avatar'] | null>(null);
type AuthField = 'displayName' | 'email' | 'password';
const authFieldErrors = ref<Partial<Record<AuthField, string>>>({});
const profileNameError = ref('');
type Page = 'home' | 'my-movies' | 'ai' | 'settings' | 'usage' | 'movie-detail' | 'login' | 'register';
const currentPage = ref<Page>(pageFromPath());
const selectedMovieId = ref(movieIdFromPath());
const atTop = ref(true);
const atBottom = ref(true);
let scrollUpdateFrame: number | undefined;
let contentObserver: MutationObserver | undefined;
let previousScrollRestoration: ScrollRestoration | undefined;

const avatarSource = computed(() => avatarPreview.value || (!avatarRemoved.value && user.value?.avatarUrl
  ? resolveApiUrl(user.value.avatarUrl)
  : ''));
const avatarHint = computed(() => avatarLimits.value
  ? t('profile.avatarHint', { maxSize: formatBytes(avatarLimits.value.maxBytes) })
  : t('profile.avatarHintUnavailable'));
const profileDirty = computed(() => Boolean(user.value) && (
  profileName.value.trim() !== user.value?.displayName
  || Boolean(avatarFile.value)
  || (avatarRemoved.value && Boolean(user.value?.avatarUrl))
));

onMounted(async () => {
  previousScrollRestoration = window.history.scrollRestoration;
  window.history.scrollRestoration = 'manual';
  window.addEventListener('popstate', syncPageFromLocation);
  window.addEventListener('scroll', scheduleScrollControlsUpdate, { passive: true });
  window.addEventListener('resize', scheduleScrollControlsUpdate);
  document.addEventListener('pointerdown', closeMenusOnOutside);
  contentObserver = new MutationObserver(scheduleScrollControlsUpdate);
  contentObserver.observe(document.querySelector('#app') ?? document.body, { childList: true, subtree: true });
  scheduleScrollControlsUpdate();
  void loadPublicConfig();
  try {
    const response = await fetch(`${apiBaseUrl}/auth/me`, { credentials: 'include' });
    if (response.ok) {
      setUser((await response.json() as AuthResponse).user);
      if (currentPage.value === 'login' || currentPage.value === 'register') navigateToPath('/', true);
    }
  } catch {
    errorMessage.value = t('errors.serviceUnavailable');
  } finally {
    loading.value = false;
    if (!user.value && ['settings', 'usage', 'my-movies', 'ai'].includes(currentPage.value)) {
      openAuth('login', true);
    }
  }
});

async function loadPublicConfig() {
  try {
    const response = await fetch(`${apiBaseUrl}/config`);
    if (response.ok) avatarLimits.value = (await response.json() as PublicConfig).avatar;
  } catch {
    // The API remains the source of truth and will enforce the limit during upload.
  }
}

async function submit() {
  errorMessage.value = '';
  successMessage.value = '';
  if (!validateAuthForm()) return;
  submitting.value = true;
  const body: LoginRequest | RegisterRequest = mode.value === 'register'
    ? { email: email.value.trim(), password: password.value, displayName: displayName.value.trim() }
    : { email: email.value.trim(), password: password.value };
  try {
    const response = await fetch(`${apiBaseUrl}/auth/${mode.value}`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json() as AuthResponse | ApiError;
    if (!response.ok) {
      if (mode.value === 'login' && response.status === 401) errorMessage.value = t('auth.invalidCredentials');
      else if (mode.value === 'register' && response.status === 409) errorMessage.value = t('auth.emailRegistered');
      else throw localizedApiError(result, 'errors.requestFailed');
      return;
    }
    setUser((result as AuthResponse).user);
    password.value = '';
    navigateToPath('/', true);
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.serviceUnavailable');
  } finally {
    submitting.value = false;
  }
}

function validateAuthForm(): boolean {
  const errors: Partial<Record<AuthField, string>> = {};
  const normalizedEmail = email.value.trim();
  const normalizedDisplayName = displayName.value.trim();

  if (mode.value === 'register') {
    if (!normalizedDisplayName) errors.displayName = t('validation.displayNameRequired');
    else if (normalizedDisplayName.length > 80) errors.displayName = t('validation.displayNameTooLong');
  }
  if (!normalizedEmail) errors.email = t('validation.emailRequired');
  else if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    errors.email = t('validation.emailInvalid');
  }
  if (!password.value) errors.password = t('validation.passwordRequired');
  else if (password.value.length < 12 || password.value.length > 128) {
    errors.password = t('validation.passwordLength');
  }

  authFieldErrors.value = errors;
  return Object.keys(errors).length === 0;
}

function clearAuthFieldError(field: AuthField) {
  if (!authFieldErrors.value[field]) return;
  authFieldErrors.value = { ...authFieldErrors.value, [field]: undefined };
}

function setUser(nextUser: AuthUser) {
  user.value = nextUser;
  profileName.value = nextUser.displayName;
  avatarRemoved.value = false;
  avatarFile.value = null;
  clearPreview();
}

function chooseAvatar(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  errorMessage.value = '';
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    errorMessage.value = t('validation.avatarType');
    input.value = '';
    return;
  }
  if (avatarLimits.value && file.size > avatarLimits.value.maxBytes) {
    errorMessage.value = t('validation.avatarSize', { maxSize: formatBytes(avatarLimits.value.maxBytes) });
    input.value = '';
    return;
  }
  clearPreview();
  avatarFile.value = file;
  avatarRemoved.value = false;
  avatarPreview.value = URL.createObjectURL(file);
}

function removeAvatar() {
  avatarFile.value = null;
  avatarRemoved.value = true;
  clearPreview();
}

async function saveProfile() {
  errorMessage.value = '';
  successMessage.value = '';
  const normalizedProfileName = profileName.value.trim();
  if (!normalizedProfileName) {
    profileNameError.value = t('validation.displayNameRequired');
    return;
  }
  if (normalizedProfileName.length > 80) {
    profileNameError.value = t('validation.displayNameTooLong');
    return;
  }
  profileNameError.value = '';
  profileName.value = normalizedProfileName;
  submitting.value = true;
  try {
    const profileResponse = await fetch(`${apiBaseUrl}/users/me`, {
      method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: normalizedProfileName }),
    });
    let result = await readAuthResponse(profileResponse);

    if (avatarFile.value) {
      const avatarResponse = await fetch(`${apiBaseUrl}/users/me/avatar`, {
        method: 'PUT', credentials: 'include', headers: { 'content-type': avatarFile.value.type }, body: avatarFile.value,
      });
      result = await readAuthResponse(avatarResponse);
    } else if (avatarRemoved.value && user.value?.avatarUrl) {
      const deleteResponse = await fetch(`${apiBaseUrl}/users/me/avatar`, { method: 'DELETE', credentials: 'include' });
      if (!deleteResponse.ok) throw await localizedResponseError(deleteResponse);
      const { avatarUrl: _removedAvatar, ...userWithoutAvatar } = result;
      result = userWithoutAvatar;
    }

    setUser(result);
    successMessage.value = t('profile.saved');
  } catch (error) {
    errorMessage.value = localizedErrorMessage(error, 'errors.requestFailed');
  } finally {
    submitting.value = false;
  }
}

async function readAuthResponse(response: Response): Promise<AuthUser> {
  const result = await response.json() as AuthResponse | ApiError;
  if (!response.ok) throw localizedApiError(result, 'errors.requestFailed');
  return (result as AuthResponse).user;
}

function resolveApiUrl(path: string): string {
  if (URL.canParse(path)) return path;
  if (apiBaseUrl.startsWith('http')) return new URL(path, apiBaseUrl).toString();
  return path;
}

function formatBytes(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  return `${Number.isInteger(mebibytes) ? mebibytes : mebibytes.toFixed(1)} MB`;
}

function clearPreview() {
  if (avatarPreview.value) URL.revokeObjectURL(avatarPreview.value);
  avatarPreview.value = '';
}

onBeforeUnmount(() => {
  clearPreview();
  window.removeEventListener('popstate', syncPageFromLocation);
  window.removeEventListener('scroll', scheduleScrollControlsUpdate);
  window.removeEventListener('resize', scheduleScrollControlsUpdate);
  document.removeEventListener('pointerdown', closeMenusOnOutside);
  contentObserver?.disconnect();
  if (scrollUpdateFrame !== undefined) window.cancelAnimationFrame(scrollUpdateFrame);
  if (previousScrollRestoration) window.history.scrollRestoration = previousScrollRestoration;
});

async function logout() {
  accountMenu.value?.removeAttribute('open');
  errorMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/auth/logout`, { method: 'POST', credentials: 'include' });
    if (response.ok) {
      user.value = null;
      navigate('home');
    }
    else errorMessage.value = localizedErrorMessage(await localizedResponseError(response), 'errors.requestFailed');
  } catch {
    errorMessage.value = t('errors.serviceUnavailable');
  }
}

function pageFromPath(): Page {
  if (movieIdFromPath()) return 'movie-detail';
  if (window.location.pathname === '/login') return 'login';
  if (window.location.pathname === '/register') return 'register';
  if (window.location.pathname === '/my-movies') return 'my-movies';
  if (window.location.pathname === '/ai') return 'ai';
  if (window.location.pathname === '/settings') return 'settings';
  return window.location.pathname === '/usage' ? 'usage' : 'home';
}

function movieIdFromPath(): number | null {
  const match = window.location.pathname.match(/^\/movies\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function syncPageFromLocation() {
  const nextPage = pageFromPath();
  currentPage.value = nextPage;
  if (nextPage === 'login' || nextPage === 'register') mode.value = nextPage;
  selectedMovieId.value = movieIdFromPath();
  errorMessage.value = '';
  successMessage.value = '';
  if (nextPage === 'home' || nextPage === 'my-movies') restoreListScroll(nextPage);
}

function openMovie(tmdbId: number) {
  const movieOrigin = currentPage.value === 'my-movies' ? 'my-movies' : 'home';
  window.history.replaceState({ ...historyState(), listPage: movieOrigin, scrollY: window.scrollY }, '');
  window.history.pushState({ movieOrigin }, '', `/movies/${tmdbId}`);
  selectedMovieId.value = tmdbId;
  currentPage.value = 'movie-detail';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function backFromMovieDetail() {
  const movieOrigin = window.history.state?.movieOrigin;
  if (movieOrigin === 'home' || movieOrigin === 'my-movies') window.history.back();
  else navigate('home');
}

function navigate(page: Page) {
  const path = page === 'settings' ? '/settings'
    : page === 'usage' ? '/usage'
      : page === 'my-movies' ? '/my-movies'
        : page === 'ai' ? '/ai' : '/';
  if (window.location.pathname !== path) window.history.pushState({}, '', path);
  currentPage.value = page;
  errorMessage.value = '';
  successMessage.value = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openAuth(nextMode: 'login' | 'register', replace = false) {
  const path = `/${nextMode}`;
  if (replace) window.history.replaceState({}, '', path);
  else window.history.pushState({}, '', path);
  mode.value = nextMode;
  currentPage.value = nextMode;
  selectedMovieId.value = null;
  errorMessage.value = '';
  successMessage.value = '';
  authFieldErrors.value = {};
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function navigateToPath(path: string, replace = false) {
  if (replace) window.history.replaceState({}, '', path);
  else window.history.pushState({}, '', path);
  currentPage.value = pageFromPath();
  selectedMovieId.value = movieIdFromPath();
  errorMessage.value = '';
  successMessage.value = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function historyState(): Record<string, unknown> {
  return window.history.state && typeof window.history.state === 'object'
    ? window.history.state as Record<string, unknown>
    : {};
}

function restoreListScroll(page: 'home' | 'my-movies') {
  const state = historyState();
  const savedScrollY = state.listPage === page && typeof state.scrollY === 'number' && Number.isFinite(state.scrollY)
    ? Math.max(0, state.scrollY)
    : 0;
  void nextTick(() => {
    window.requestAnimationFrame(() => window.scrollTo({ top: savedScrollY, behavior: 'auto' }));
  });
}

function scheduleScrollControlsUpdate() {
  if (scrollUpdateFrame !== undefined) return;
  scrollUpdateFrame = window.requestAnimationFrame(() => {
    scrollUpdateFrame = undefined;
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    atTop.value = window.scrollY <= 8;
    atBottom.value = maxScroll <= 8 || window.scrollY >= maxScroll - 8;
  });
}

function scrollToEdge(edge: 'top' | 'bottom') {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({
    top: edge === 'top' ? 0 : document.documentElement.scrollHeight,
    behavior: reduceMotion ? 'auto' : 'smooth',
  });
}

function chooseLocale(nextLocale: 'zh-CN' | 'en-US') {
  setLocale(nextLocale);
  localeMenu.value?.removeAttribute('open');
}

function navigateFromAccount(page: 'settings' | 'usage') {
  accountMenu.value?.removeAttribute('open');
  navigate(page);
}

function closeMenusOnOutside(event: PointerEvent) {
  if (!(event.target instanceof Node)) return;
  for (const menu of [localeMenu.value, accountMenu.value]) {
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
  <main class="app-shell">
    <header class="site-header">
      <button class="brand brand-button" type="button" @click="navigate('home')">
        <span class="brand-mark">MH</span>
        <span class="brand-copy">MOVIE HUB<small>CINEMA INDEX</small></span>
      </button>
      <nav class="site-nav" :aria-label="t('nav.ariaLabel')">
        <button type="button" :class="{ active: currentPage === 'home' }" @click="navigate('home')">{{ t('nav.discover') }}</button>
        <button v-if="user" type="button" :class="{ active: currentPage === 'my-movies' }" @click="navigate('my-movies')">{{ t('nav.myMovies') }}</button>
        <button v-if="user" type="button" :class="{ active: currentPage === 'ai' }" @click="navigate('ai')">{{ t('nav.ai') }}</button>
        <details ref="localeMenu" class="locale-switcher">
          <summary
            :aria-label="`${t('language.label')}: ${t(`language.${locale}`)}`"
            :title="t('language.label')"
          >
            <svg class="locale-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9S14.4 18.5 12 21M12 3C9.6 5.5 8.4 8.5 8.4 12s1.2 6.5 3.6 9" />
            </svg>
          </summary>
          <div class="locale-options" role="group" :aria-label="t('language.label')">
            <button
              type="button"
              :class="{ active: locale === 'zh-CN' }"
              :aria-pressed="locale === 'zh-CN'"
              @click="chooseLocale('zh-CN')"
            >
              {{ t('language.zh-CN') }}
            </button>
            <button
              type="button"
              :class="{ active: locale === 'en-US' }"
              :aria-pressed="locale === 'en-US'"
              @click="chooseLocale('en-US')"
            >
              {{ t('language.en-US') }}
            </button>
          </div>
        </details>
        <details v-if="user" ref="accountMenu" class="account-menu" @keydown.esc.prevent="closeAccountMenu">
          <summary class="account-trigger" :aria-label="t('a11y.accountMenu')">
            <span class="nav-avatar"
              ><img v-if="user.avatarUrl" :src="resolveApiUrl(user.avatarUrl)" :alt="t('a11y.currentAvatar', { name: user.displayName })" /><span v-else>{{ user.displayName.slice(0, 1).toUpperCase() }}</span></span
            >
            <span class="account-tooltip" role="tooltip">{{ user.displayName }}</span>
          </summary>
          <div class="account-options">
            <div class="account-identity">
              <span class="nav-avatar menu-avatar"
                ><img v-if="user.avatarUrl" :src="resolveApiUrl(user.avatarUrl)" alt="" /><span v-else>{{ user.displayName.slice(0, 1).toUpperCase() }}</span></span
              >
              <span class="account-identity-copy"><strong>{{ user.displayName }}</strong><small>{{ user.email }}</small></span>
            </div>
            <div class="account-action-group">
              <button type="button" :class="{ active: currentPage === 'settings' }" @click="navigateFromAccount('settings')">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.07 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63a1.7 1.7 0 0 0 1-1.56V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.93 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" /></svg>
                <span>{{ t('nav.settings') }}</span>
              </button>
              <button type="button" :class="{ active: currentPage === 'usage' }" @click="navigateFromAccount('usage')">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V9m5 10V5m5 14v-7m5 7V3" /></svg>
                <span>{{ t('nav.usage') }}</span>
              </button>
            </div>
            <div class="account-action-group account-signout-group">
              <button class="danger" type="button" @click="logout">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5m5 5H3m11-9h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" /></svg>
                <span>{{ t('nav.logout') }}</span>
              </button>
            </div>
          </div>
        </details>
        <button v-else class="account-link" type="button" :disabled="loading" :aria-label="t('nav.loginOrRegister')" @click="openAuth('login')">
          {{ loading ? '…' : t('nav.loginOrRegister') }}
        </button>
      </nav>
    </header>

    <KeepAlive :max="2">
      <MovieBrowser
        v-if="currentPage === 'home'"
        :key="user?.id ?? 'anonymous'"
        :authenticated="Boolean(user)"
        @require-login="openAuth('login')"
        @open-movie="openMovie"
      />
    </KeepAlive>
    <KeepAlive :max="2">
      <MyMovies v-if="currentPage === 'my-movies' && user" :key="user.id" @open-movie="openMovie" />
    </KeepAlive>
    <MovieDetail
      v-if="currentPage === 'movie-detail' && selectedMovieId"
      :tmdb-id="selectedMovieId"
      :authenticated="Boolean(user)"
      @back="backFromMovieDetail"
      @require-login="openAuth('login')"
    />
    <UsageStatistics v-if="currentPage === 'usage' && user" />
    <AiChat v-if="currentPage === 'ai' && user" :key="user.id" @open-settings="navigate('settings')" />

    <section v-if="currentPage === 'login' || currentPage === 'register'" class="auth-page">
      <div class="page-toolbar">
        <button class="back-button" type="button" @click="navigate('home')">{{ t('actions.backHome') }}</button>
      </div>
      <div class="auth-layout">
        <div class="auth-card" :aria-busy="submitting">
          <form novalidate @submit.prevent="submit">
              <label v-if="mode === 'register'" for="auth-display-name">
                {{ t('profile.displayNameLabel') }}
                <input id="auth-display-name" v-model="displayName" name="name" autocomplete="name" maxlength="80" required :placeholder="t('profile.displayNamePlaceholder')" :aria-invalid="Boolean(authFieldErrors.displayName)" :aria-describedby="authFieldErrors.displayName ? 'auth-display-name-error' : undefined" @input="clearAuthFieldError('displayName')" />
                <small v-if="authFieldErrors.displayName" id="auth-display-name-error" class="field-error">{{ authFieldErrors.displayName }}</small>
              </label>
              <label for="auth-email">
                {{ t('profile.authEmailLabel') }}
                <input id="auth-email" v-model="email" name="email" type="email" autocomplete="email" maxlength="254" required :placeholder="t('profile.emailPlaceholder')" :aria-invalid="Boolean(authFieldErrors.email)" :aria-describedby="authFieldErrors.email ? 'auth-email-error' : undefined" @input="clearAuthFieldError('email')" />
                <small v-if="authFieldErrors.email" id="auth-email-error" class="field-error">{{ authFieldErrors.email }}</small>
              </label>
              <label for="auth-password">
                {{ t('profile.passwordLabel') }}
                <input
                  id="auth-password"
                  v-model="password"
                  name="password"
                  type="password"
                  :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
                  minlength="12"
                  maxlength="128"
                  required
                  :placeholder="mode === 'login' ? t('profile.loginPasswordPlaceholder') : t('profile.passwordPlaceholder')"
                  :aria-invalid="Boolean(authFieldErrors.password)"
                  :aria-describedby="authFieldErrors.password ? 'auth-password-error' : undefined"
                  @input="clearAuthFieldError('password')"
                />
                <small v-if="authFieldErrors.password" id="auth-password-error" class="field-error">{{ authFieldErrors.password }}</small>
              </label>
              <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
              <button class="primary" type="submit" :disabled="submitting">
                {{ submitting ? (mode === 'login' ? t('account.loggingIn') : t('account.registering')) : mode === 'login' ? t('account.loginTab') : t('account.createAccount') }}
              </button>
            </form>
            <p class="switch-copy">
              {{ mode === 'login' ? t('account.noAccount') : t('account.hasAccount') }}
              <button class="text-button" type="button" @click="openAuth(mode === 'login' ? 'register' : 'login', true)">
                {{ mode === 'login' ? t('account.registerNow') : t('account.backToLogin') }}
              </button>
            </p>
        </div>
      </div>
    </section>

    <section v-if="currentPage === 'settings' && (loading || user)" class="settings-page">
      <div class="page-toolbar">
        <button class="back-button" type="button" @click="navigate('home')">{{ t('actions.backHome') }}</button>
      </div>
      <div v-if="loading" class="loading">{{ t('status.checkingAuthentication') }}</div>
      <template v-else-if="user">
        <div class="settings-heading">
          <p class="eyebrow">{{ t('account.eyebrow') }}</p>
          <h1>{{ t('account.settingsTitle') }}</h1>
          <p>{{ t('account.settingsDescription') }}</p>
        </div>
        <form class="settings-form" novalidate @submit.prevent="saveProfile">
          <section class="settings-card profile-settings-card" aria-labelledby="profile-section-title">
            <div class="settings-card-heading profile-card-heading">
              <div>
                <h2 id="profile-section-title">{{ t('profile.basicSection') }}</h2>
                <p>{{ t('profile.basicSectionDescription') }}</p>
              </div>
              <div class="profile-avatar-editor">
                <div class="avatar large">
                  <img v-if="avatarSource" :src="avatarSource" :alt="t('a11y.currentAvatar', { name: profileName || user.displayName })" />
                  <span v-else>{{ profileName.slice(0, 1).toUpperCase() || '?' }}</span>
                </div>
                <div class="avatar-actions profile-avatar-actions">
                  <label class="upload-button">
                    {{ t('profile.avatarChoose') }}
                    <input class="file-input" type="file" accept="image/jpeg,image/png,image/webp" :aria-label="t('a11y.chooseAvatar')" @change="chooseAvatar" />
                  </label>
                  <button v-if="avatarSource || user.avatarUrl" class="text-button danger" type="button" @click="removeAvatar">{{ t('profile.avatarRemove') }}</button>
                  <small>{{ avatarHint }}</small>
                </div>
              </div>
            </div>
            <div class="settings-fields">
              <label for="profile-display-name">
                {{ t('profile.displayNameLabel') }}
                <input
                  id="profile-display-name"
                  v-model="profileName"
                  name="displayName"
                  autocomplete="name"
                  maxlength="80"
                  required
                  :placeholder="t('profile.displayNamePlaceholder')"
                  :aria-invalid="Boolean(profileNameError)"
                  :aria-describedby="profileNameError ? 'profile-display-name-error' : undefined"
                  @input="profileNameError = ''"
                />
                <small v-if="profileNameError" id="profile-display-name-error" class="field-error">{{ profileNameError }}</small>
              </label>
              <div class="readonly-field">
                <div class="readonly-field-heading">
                  <span>{{ t('profile.emailLabel') }}</span>
                  <small>{{ t('profile.emailReadonlyHint') }}</small>
                </div>
                <strong>{{ user.email }}</strong>
              </div>
            </div>
            <div class="settings-card-footer">
              <div class="settings-feedback">
                <p v-if="errorMessage" class="error settings-message" role="alert">{{ errorMessage }}</p>
                <p v-if="successMessage" class="success settings-message" role="status" aria-live="polite">{{ successMessage }}</p>
              </div>
              <div class="settings-actions">
                <button class="primary" type="submit" :disabled="submitting || !profileDirty">
                  {{ submitting ? t('profile.saving') : t('profile.save') }}
                </button>
              </div>
            </div>
          </section>
        </form>
        <section class="settings-section" aria-labelledby="integrations-section-title">
          <div class="settings-section-heading">
            <h2 id="integrations-section-title">{{ t('integrations.sectionTitle') }}</h2>
            <p>{{ t('integrations.sectionDescription') }}</p>
          </div>
          <div class="settings-form">
            <OpenAISettings :key="user?.id" />
            <MTeamSettings />
            <QBittorrentSettings />
            <TransmissionSettings />
          </div>
        </section>
      </template>
    </section>

    <nav
      v-if="(currentPage === 'home' || currentPage === 'my-movies' || currentPage === 'movie-detail') && (!atTop || !atBottom)"
      class="scroll-controls"
      :aria-label="t('a11y.pageNavigation')"
    >
      <button v-if="!atTop" type="button" :aria-label="t('actions.toTop')" @click="scrollToEdge('top')">
        <span aria-hidden="true">↑</span><span>Top</span>
      </button>
      <button v-if="!atBottom" type="button" :aria-label="t('actions.toBottom')" @click="scrollToEdge('bottom')">
        <span aria-hidden="true">↓</span><span>Bottom</span>
      </button>
    </nav>
  </main>
</template>
