import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import messages from '@movie-hub/helper-agent-ui/messages';
import documentation from '@movie-hub/helper-agent-ui/documentation';
import type { AgentHost } from '@movie-hub/helper-agent-ui/transport';
import { createWebAgentClient } from './web-agent.client';

export function useManagement() {
  const locale = ref<'en-US' | 'zh-CN'>(navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US');
  const t = computed(() => messages[locale.value]);
  watch(
    locale,
    () => {
      document.documentElement.lang = locale.value;
      document.title = t.value.managementTitle;
    },
    { immediate: true }
  );
  const password = ref('');
  const authenticated = ref(false);
  const loading = ref(true);
  const busy = ref(false);
  const error = ref('');
  const version = ref('');
  let signingOut = false;
  let active = true;
  let generation = 0;
  const transport = createWebAgentClient({
    onSessionExpired() {
      if (!active) return;
      authenticated.value = false;
      password.value = '';
      const currentLocale = document.documentElement.lang;
      if (currentLocale === 'zh-CN' || currentLocale === 'en-US') locale.value = currentLocale;
      error.value = signingOut ? '' : 'managementSessionExpired';
      generation++;
    },
  });
  function text(code: string) {
    return (t.value as Record<string, string>)[code] ?? t.value.unknownError;
  }
  const host = computed<AgentHost>(() => ({
    version: version.value,
    openDocumentation: async (provider) => {
      const opened = window.open(documentation[provider], '_blank', 'noopener,noreferrer');
      if (opened) opened.opener = null;
    },
    signOut: async () => {
      await signOut();
    },
  }));
  async function checkSession() {
    const current = ++generation;
    loading.value = true;
    error.value = '';
    try {
      const session = await transport.session();
      if (!active || current !== generation) return;
      authenticated.value = session.authenticated;
      version.value = session.version;
    } catch (cause) {
      if (active && current === generation) error.value = typeof cause === 'string' ? cause : 'networkError';
    } finally {
      if (active && current === generation) loading.value = false;
    }
  }
  async function login() {
    if (busy.value || !password.value || loading.value) return;
    const current = ++generation;
    busy.value = true;
    error.value = '';
    try {
      const session = await transport.login(password.value);
      if (!active || current !== generation) return;
      authenticated.value = session.authenticated;
      version.value = session.version;
    } catch (cause) {
      if (active && current === generation) error.value = typeof cause === 'string' ? cause : 'networkError';
    } finally {
      if (active && current === generation) {
        busy.value = false;
        password.value = '';
      }
    }
  }
  async function signOut() {
    if (busy.value) return;
    busy.value = true;
    signingOut = true;
    try {
      await transport.logout();
    } finally {
      signingOut = false;
      if (active) {
        busy.value = false;
        password.value = '';
      }
    }
  }
  onMounted(() => void checkSession());
  onBeforeUnmount(() => {
    active = false;
    generation++;
    password.value = '';
    transport.close();
  });
  return {
    locale,
    t,
    text,
    password,
    authenticated,
    loading,
    busy,
    error,
    host,
    client: transport.client,
    checkSession,
    login,
  };
}
