// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { useAgentTheme } from './agent-theme.composable';

const wrappers: ReturnType<typeof mount>[] = [];
function render() {
  const wrapper = mount(defineComponent({
    setup: useAgentTheme,
    template: '<button @click="toggleTheme">{{ theme }}</button>',
  }));
  wrappers.push(wrapper);
  return wrapper;
}
beforeEach(() => {
  localStorage.removeItem('popular-agent-theme');
  delete document.documentElement.dataset.agentTheme;
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('follows system changes until the user chooses a theme and removes its listener on unmount', async () => {
  const system = new EventTarget();
  const remove = vi.spyOn(system, 'removeEventListener');
  vi.stubGlobal('matchMedia', vi.fn(() => Object.assign(system, { matches: true })));
  const wrapper = render();
  expect(document.documentElement.dataset.agentTheme).toBe('dark');
  system.dispatchEvent(new MediaQueryListEvent('change', { matches: false }));
  expect(document.documentElement.dataset.agentTheme).toBe('light');
  await wrapper.get('button').trigger('click');
  expect(document.documentElement.dataset.agentTheme).toBe('dark');
  system.dispatchEvent(new MediaQueryListEvent('change', { matches: false }));
  expect(document.documentElement.dataset.agentTheme).toBe('dark');
  wrapper.unmount();
  expect(remove).toHaveBeenCalledWith('change', expect.any(Function));
});

it('uses the stored light theme even when the system is dark', () => {
  localStorage.setItem('popular-agent-theme', 'light');
  vi.stubGlobal('matchMedia', vi.fn(() => Object.assign(new EventTarget(), { matches: true })));
  render();
  expect(document.documentElement.dataset.agentTheme).toBe('light');
});

it('can switch when reading and writing storage are blocked', async () => {
  vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  const wrapper = render();
  const initial = document.documentElement.dataset.agentTheme;
  await wrapper.get('button').trigger('click');
  expect(document.documentElement.dataset.agentTheme).toBe(initial === 'dark' ? 'light' : 'dark');
});
