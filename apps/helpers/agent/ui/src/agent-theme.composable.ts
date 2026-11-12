import { onBeforeUnmount, ref, watchEffect } from 'vue';
import type { AgentTheme } from './agent-theme.types';

const storageKey = 'popular-agent-theme';

export function useAgentTheme() {
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const preference = ref<AgentTheme | null>(null);
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark') preference.value = saved;
  } catch {
    // Restricted storage must not prevent changing the appearance.
  }
  const theme = ref<AgentTheme>(preference.value ?? (system.matches ? 'dark' : 'light'));
  watchEffect(() => {
    document.documentElement.dataset.agentTheme = theme.value;
  }, { flush: 'sync' });
  function followSystem(event: MediaQueryListEvent) {
    if (preference.value === null) theme.value = event.matches ? 'dark' : 'light';
  }
  system.addEventListener('change', followSystem);
  onBeforeUnmount(() => system.removeEventListener('change', followSystem));

  function toggleTheme() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
    preference.value = theme.value;
    try {
      window.localStorage.setItem(storageKey, theme.value);
    } catch {
      // The current session can still use the chosen theme.
    }
  }
  return { theme, toggleTheme };
}
