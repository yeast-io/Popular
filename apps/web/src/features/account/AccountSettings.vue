<script setup lang="ts">
import { useI18n } from '../../i18n';
import type { AccountSettingsProps } from './account-settings.types';

const props = defineProps<AccountSettingsProps>();
const { locale, t } = useI18n();
const { profileName, profileNameError, avatarSource, avatarHint, profileDirty, submitting,
  errorMessage, successMessage, localeError, localeSaveState, chooseAvatar, removeAvatar,
  saveProfile, chooseLocale } = props.account;
</script>

<template>
  <div v-show="section === 'language'" class="settings-form">
    <section class="settings-card language-settings-card" :aria-label="t('language.label')">
      <fieldset class="locale-options">
        <legend class="sr-only">{{ t('language.label') }}</legend>
        <label v-for="choice in (['zh-CN', 'en-US'] as const)" :key="choice" class="locale-card" :class="{ active: locale === choice }">
          <input type="radio" name="system-language" :value="choice" :checked="locale === choice" @change="chooseLocale(choice)" />
          <span class="locale-card-symbol" aria-hidden="true">{{ t(`language.symbol.${choice}`) }}</span>
          <span class="locale-card-copy">
            <span class="locale-card-title" :lang="choice">{{ t(`language.native.${choice}`) }}</span>
            <span class="locale-card-subtitle">{{ t(`language.subtitle.${choice}`) }}</span>
          </span>
          <span class="locale-card-check" aria-hidden="true">
            <svg v-if="locale === choice" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 8 3 3 5-6" /></svg>
          </span>
        </label>
      </fieldset>
      <p class="locale-save-status" role="status" aria-live="polite">
        {{ localeSaveState === 'saving' ? t('language.saving') : localeSaveState === 'saved' ? t('language.saved') : t('language.autoSave') }}
      </p>
      <p v-if="localeError" class="error settings-message" role="alert">{{ localeError }}</p>
    </section>
  </div>
  <form v-show="section === 'profile'" class="settings-form" novalidate @submit.prevent="saveProfile">
    <section class="settings-card profile-settings-card" :aria-label="t('settings.profile')">
      <div class="settings-card-heading profile-card-heading">
        <div class="profile-avatar-editor">
          <div class="avatar large">
            <img
              v-if="avatarSource"
              :src="avatarSource"
              :alt="t('a11y.currentAvatar', { name: profileName || user.displayName })"
            />
            <span v-else>{{ profileName.slice(0, 1).toUpperCase() || '?' }}</span>
          </div>
          <div class="avatar-actions profile-avatar-actions">
            <label class="upload-button">
              {{ t('profile.avatarChoose') }}
              <input
                class="file-input"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                :aria-label="t('a11y.chooseAvatar')"
                @change="chooseAvatar"
              />
            </label>
            <button
              v-if="avatarSource || user.avatarUrl"
              class="text-button danger"
              type="button"
              @click="removeAvatar"
            >
              {{ t('profile.avatarRemove') }}
            </button>
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
          <small v-if="profileNameError" id="profile-display-name-error" class="field-error">{{
            profileNameError
          }}</small>
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
          <p v-if="successMessage" class="success settings-message" role="status" aria-live="polite">
            {{ successMessage }}
          </p>
        </div>
        <div class="settings-actions">
          <button class="primary" type="submit" :disabled="submitting || !profileDirty">
            {{ submitting ? t('profile.saving') : t('profile.save') }}
          </button>
        </div>
      </div>
    </section>
  </form>
</template>
