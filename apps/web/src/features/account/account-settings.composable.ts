import type { ApiError, AuthResponse, AuthUser, PublicConfig } from '@movie-hub/contract';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import { localizedApiError, localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';
import type { AccountSettingsOptions } from './account-settings.types';

export function useAccountSettings(options: AccountSettingsOptions) {
  const { apiBaseUrl } = loadWebConfig();
  const { locale, setLocale, t } = useI18n();
  const user = options.user;
  const submitting = ref(false);
  const errorMessage = ref('');
  let localeSaveQueue = Promise.resolve();
  let localeRevision = 0;
  let disposed = false;
  const localeError = ref('');
  const localeSaveState = ref<'idle' | 'saving' | 'saved'>('idle');
  const successMessage = ref('');
  const profileName = ref('');
  const avatarFile = ref<File | null>(null);
  const avatarRemoved = ref(false);
  const avatarPreview = ref('');
  const avatarLimits = ref<PublicConfig['avatar'] | null>(null);
  const profileNameError = ref('');
  const avatarSource = computed(() => {
    return (
      avatarPreview.value || (!avatarRemoved.value && user.value?.avatarUrl ? resolveApiUrl(user.value.avatarUrl) : '')
    );
  });
  const avatarHint = computed(() => {
    return avatarLimits.value
      ? t('profile.avatarHint', { maxSize: formatBytes(avatarLimits.value.maxBytes) })
      : t('profile.avatarHintUnavailable');
  });
  const profileDirty = computed(() => {
    return (
      Boolean(user.value)
      && (profileName.value.trim() !== user.value?.displayName
        || Boolean(avatarFile.value)
        || (avatarRemoved.value && Boolean(user.value?.avatarUrl)))
    );
  });

  watch(() => user.value?.id, () => {
    ++localeRevision;
    localeError.value = '';
    localeSaveState.value = 'idle';
    clearFeedback();
    if (user.value?.locale) setLocale(user.value.locale);
    else if (user.value) chooseLocale(locale.value);
  }, { immediate: true, flush: 'sync' });

  watch([() => user.value?.id, () => user.value?.displayName, () => user.value?.avatarUrl], resetProfileEditor, { immediate: true, flush: 'sync' });

  function resetProfileEditor() {
    profileName.value = user.value?.displayName ?? '';
    avatarRemoved.value = false;
    avatarFile.value = null;
    profileNameError.value = '';
    clearPreview();
  }

  function setAvatarLimits(limits: PublicConfig['avatar']) {
    avatarLimits.value = limits;
  }

  function clearFeedback() {
    errorMessage.value = '';
    successMessage.value = '';
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
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: normalizedProfileName }),
      });
      let result = await readAuthResponse(profileResponse);

      if (avatarFile.value) {
        const avatarResponse = await fetch(`${apiBaseUrl}/users/me/avatar`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'content-type': avatarFile.value.type },
          body: avatarFile.value,
        });
        result = await readAuthResponse(avatarResponse);
      } else if (avatarRemoved.value && user.value?.avatarUrl) {
        const deleteResponse = await fetch(`${apiBaseUrl}/users/me/avatar`, { method: 'DELETE', credentials: 'include' });
        if (!deleteResponse.ok) throw await localizedResponseError(deleteResponse);
        const { avatarUrl: _removedAvatar, ...userWithoutAvatar } = result;
        result = userWithoutAvatar;
      }

      options.onUserUpdated(result);
      resetProfileEditor();
      successMessage.value = t('profile.saved');
    } catch (error) {
      errorMessage.value = localizedErrorMessage(error, 'errors.requestFailed');
    } finally {
      submitting.value = false;
    }
  }

  async function readAuthResponse(response: Response): Promise<AuthUser> {
    const result = (await response.json()) as AuthResponse | ApiError;
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
  function chooseLocale(nextLocale: 'zh-CN' | 'en-US') {
    localeError.value = '';
    setLocale(nextLocale);
    const ownerId = user.value?.id;
    if (!ownerId) return;
    const revision = ++localeRevision;
    localeSaveState.value = 'saving';
    localeSaveQueue = localeSaveQueue.then(async () => {
      if (disposed || user.value?.id !== ownerId) {
        if (revision === localeRevision) localeSaveState.value = 'idle';
        return;
      }
      try {
        const response = await fetch(`${apiBaseUrl}/users/me/locale`, {
          method: 'PUT', credentials: 'include',
          headers: { 'content-type': 'application/json', 'accept-language': nextLocale },
          body: JSON.stringify({ locale: nextLocale }),
        });
        if (!response.ok) throw response;
        if (!disposed && user.value?.id === ownerId) {
          options.onUserUpdated({ ...user.value, locale: nextLocale });
          if (revision === localeRevision) localeSaveState.value = 'saved';
        }
      } catch (error) {
        if (!disposed && user.value?.id === ownerId && revision === localeRevision) {
          localeSaveState.value = 'idle';
          if (user.value.locale) setLocale(user.value.locale);
          localeError.value = localizedErrorMessage(
            error instanceof Response ? await localizedResponseError(error) : error, 'errors.serviceUnavailable');
        }
      }
    });
  }

  onBeforeUnmount(() => {
    disposed = true;
    ++localeRevision;
    clearPreview();
  });

  return { profileName, profileNameError, avatarSource, avatarHint, profileDirty, submitting,
    errorMessage, successMessage, localeError, localeSaveState, chooseAvatar, removeAvatar,
    saveProfile, chooseLocale, setAvatarLimits, clearFeedback, resolveApiUrl };
}
