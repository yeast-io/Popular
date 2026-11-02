import type { ApiError, AuthResponse, AuthUser, LoginRequest, RegisterRequest, RegistrationPendingResponse } from '@movie-hub/contract';
import { readonly, ref } from 'vue';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import { localizedApiError, localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';
import type { AuthenticationOptions, AuthField, AuthMode } from './authentication.types';

export function useAuthentication(options: AuthenticationOptions) {
  const { apiBaseUrl } = loadWebConfig();
  const { locale, t } = useI18n();
  const mode = ref<'login' | 'register'>(window.location.pathname === '/register' ? 'register' : 'login');
  const verificationEmail = ref('');
  const verificationCode = ref('');
  const email = ref('');
  const password = ref('');
  const displayName = ref('');
  const user = ref<AuthUser | null>(null);
  const loading = ref(true);
  const submitting = ref(false);
  const errorMessage = ref('');
  const authFieldErrors = ref<Partial<Record<AuthField, string>>>({});

  function updateUser(nextUser: AuthUser) {
    user.value = nextUser;
  }

  async function restoreSession() {
    try {
      const response = await fetch(`${apiBaseUrl}/auth/me`, { credentials: 'include' });
      if (response.ok) updateUser(((await response.json()) as AuthResponse).user);
    } catch {
      errorMessage.value = t('errors.serviceUnavailable');
    } finally {
      loading.value = false;
    }
  }

  function resetForm(nextMode: AuthMode) {
    mode.value = nextMode;
    verificationEmail.value = '';
    verificationCode.value = '';
    authFieldErrors.value = {};
    clearFeedback();
  }

  function syncMode(nextMode: AuthMode) {
    mode.value = nextMode;
  }

  function clearFeedback() {
    errorMessage.value = '';
  }

  async function submit() {
    errorMessage.value = '';
    if (verificationEmail.value) {
      await verifyRegistration();
      return;
    }
    if (!validateAuthForm()) return;
    submitting.value = true;
    const body: LoginRequest | RegisterRequest
      = mode.value === 'register'
        ? { email: email.value.trim(), password: password.value, displayName: displayName.value.trim() }
        : { email: email.value.trim(), password: password.value };
    try {
      const response = await fetch(`${apiBaseUrl}/auth/${mode.value}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'accept-language': locale.value },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as AuthResponse | RegistrationPendingResponse | ApiError;
      if (!response.ok) {
        if (mode.value === 'login' && response.status === 401) errorMessage.value = t('auth.invalidCredentials');
        else if (mode.value === 'register' && response.status === 409) errorMessage.value = t('auth.emailRegistered');
        else throw localizedApiError(result, 'errors.requestFailed');
        return;
      }
      if (mode.value === 'register') {
        verificationEmail.value = (result as RegistrationPendingResponse).email;
        verificationCode.value = '';
        return;
      }
      updateUser((result as AuthResponse).user);
      password.value = '';
      options.onAuthenticated();
    } catch (error) {
      errorMessage.value = localizedErrorMessage(error, 'errors.serviceUnavailable');
    } finally {
      submitting.value = false;
    }
  }

  async function verifyRegistration() {
    if (!/^[0-9]{6}$/.test(verificationCode.value)) {
      errorMessage.value = t('auth.codeFormat');
      return;
    }
    submitting.value = true;
    try {
      const response = await fetch(`${apiBaseUrl}/auth/verify-email`, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'accept-language': locale.value },
        body: JSON.stringify({ email: verificationEmail.value, code: verificationCode.value, password: password.value }),
      });
      if (!response.ok) throw await localizedResponseError(response);
      updateUser(((await response.json()) as AuthResponse).user);
      verificationEmail.value = '';
      verificationCode.value = '';
      password.value = '';
      options.onAuthenticated();
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
  async function logout() {
    errorMessage.value = '';
    try {
      const response = await fetch(`${apiBaseUrl}/auth/logout`, { method: 'POST', credentials: 'include' });
      if (response.ok) {
        user.value = null;
        return true;
      } else errorMessage.value = localizedErrorMessage(await localizedResponseError(response), 'errors.requestFailed');
    } catch {
      errorMessage.value = t('errors.serviceUnavailable');
    }
    return false;
  }

  return { user: readonly(user), loading: readonly(loading), mode, verificationEmail, verificationCode,
    email, password, displayName, submitting, errorMessage, authFieldErrors,
    updateUser, restoreSession, resetForm, syncMode, clearFeedback, submit, clearAuthFieldError, logout };
}
