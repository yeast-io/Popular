<script setup lang="ts">
import { useI18n } from '../../i18n';
import type { AuthenticationPageProps, AuthMode } from './authentication.types';

const props = defineProps<AuthenticationPageProps>();
const emit = defineEmits<{ 'back': []; 'open-auth': [mode: AuthMode] }>();
const { t } = useI18n();
const { mode, verificationEmail, verificationCode, email, password, displayName,
  submitting, errorMessage, authFieldErrors, submit, clearAuthFieldError } = props.authentication;
</script>

<template>
  <section class="auth-page">
    <div class="page-toolbar">
      <button class="back-button" type="button" @click="emit('back')">{{ t('actions.backHome') }}</button>
    </div>
    <div class="auth-layout">
      <div class="auth-card" :class="{ 'verification-card': verificationEmail }" :aria-busy="submitting">
        <form novalidate @submit.prevent="submit">
          <template v-if="verificationEmail">
            <header class="verification-heading">
              <span class="verification-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></svg>
              </span>
              <h1>{{ t('auth.verificationHeading') }}</h1>
              <p role="status">{{ t('auth.codeSent') }}</p>
              <strong class="verification-email">{{ verificationEmail }}</strong>
            </header>
            <div class="verification-entry">
              <label for="auth-code">{{ t('auth.codeLabel') }}</label>
              <input id="auth-code" v-model="verificationCode" name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" maxlength="6" placeholder="000000" required :disabled="submitting" aria-describedby="auth-code-hint" :aria-invalid="Boolean(errorMessage)" />
              <p id="auth-code-hint" class="verification-expiry">{{ t('auth.codeExpiry') }}</p>
            </div>
          </template>
          <template v-else>
            <label v-if="mode === 'register'" for="auth-display-name">
              {{ t('profile.displayNameLabel') }}
              <input
                id="auth-display-name"
                v-model="displayName"
                name="name"
                autocomplete="name"
                maxlength="80"
                required
                :placeholder="t('profile.displayNamePlaceholder')"
                :aria-invalid="Boolean(authFieldErrors.displayName)"
                :aria-describedby="authFieldErrors.displayName ? 'auth-display-name-error' : undefined"
                @input="clearAuthFieldError('displayName')"
              />
              <small v-if="authFieldErrors.displayName" id="auth-display-name-error" class="field-error">{{
                authFieldErrors.displayName
              }}</small>
            </label>
            <label for="auth-email">
              {{ t('profile.authEmailLabel') }}
              <input
                id="auth-email"
                v-model="email"
                name="email"
                type="email"
                autocomplete="email"
                maxlength="254"
                required
                :placeholder="t('profile.emailPlaceholder')"
                :aria-invalid="Boolean(authFieldErrors.email)"
                :aria-describedby="authFieldErrors.email ? 'auth-email-error' : undefined"
                @input="clearAuthFieldError('email')"
              />
              <small v-if="authFieldErrors.email" id="auth-email-error" class="field-error">{{
                authFieldErrors.email
              }}</small>
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
                :placeholder="
                  mode === 'login' ? t('profile.loginPasswordPlaceholder') : t('profile.passwordPlaceholder')
                "
                :aria-invalid="Boolean(authFieldErrors.password)"
                :aria-describedby="authFieldErrors.password ? 'auth-password-error' : undefined"
                @input="clearAuthFieldError('password')"
              />
              <small v-if="authFieldErrors.password" id="auth-password-error" class="field-error">{{
                authFieldErrors.password
              }}</small>
            </label>
          </template>
          <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
          <button class="primary" type="submit" :disabled="submitting">
            {{
              verificationEmail
                ? submitting ? t('auth.verifying') : t('auth.verifyEmail')
                : submitting
                ? mode === 'login'
                  ? t('account.loggingIn')
                  : t('account.registering')
                : mode === 'login'
                  ? t('account.loginTab')
                  : t('account.createAccount')
            }}
          </button>
        </form>
        <nav v-if="verificationEmail" class="verification-navigation" :aria-label="t('auth.verificationNavigation')">
          <button type="button" class="text-button" :disabled="submitting" @click="emit('open-auth', 'register')">{{ t('auth.restartRegistration') }}</button>
          <button type="button" class="text-button" :disabled="submitting" @click="emit('open-auth', 'login')">{{ t('account.backToLogin') }}</button>
        </nav>
        <details v-if="verificationEmail" class="verification-help">
          <summary>{{ t('auth.codeHelp') }}</summary>
          <p>{{ t('auth.codeLimits') }}</p>
        </details>
        <p v-if="!verificationEmail" class="switch-copy">
          {{ mode === 'login' ? t('account.noAccount') : t('account.hasAccount') }}
          <button class="text-button" type="button" @click="emit('open-auth', mode === 'login' ? 'register' : 'login')">
            {{ mode === 'login' ? t('account.registerNow') : t('account.backToLogin') }}
          </button>
        </p>
      </div>
    </div>
  </section>
</template>
