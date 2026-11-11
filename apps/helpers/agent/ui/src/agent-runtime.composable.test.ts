// @vitest-environment happy-dom
import { defineComponent } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAgentRuntime } from './agent-runtime.composable';
import type { RuntimeStatus } from './settings.types';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const initial: RuntimeStatus = {
  service: 'online',
  downloader: 'online',
  deviceId: 'old',
  binding: 'bound',
  preferenceError: null,
};
it('serializes reads and discards the pre-action result before fetching fresh state', async () => {
  let finish!: (status: RuntimeStatus) => void;
  const getRuntime = vi
    .fn<() => Promise<RuntimeStatus>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    )
    .mockResolvedValue({ ...initial, deviceId: 'new' });
  let state!: ReturnType<typeof useAgentRuntime>;
  const wrapper = mount(
    defineComponent({
      setup() {
        state = useAgentRuntime({ getRuntime });
        return () => null;
      },
    })
  );
  try {
    await vi.advanceTimersByTimeAsync(6000);
    expect(getRuntime).toHaveBeenCalledTimes(1);
    const fresh = state.refreshRuntime(true);
    finish(initial);
    await fresh;
    expect(state.runtime.value.deviceId).toBe('new');
    expect(getRuntime).toHaveBeenCalledTimes(2);
  } finally {
    wrapper.unmount();
  }
});
it('ignores a delayed response and does not schedule another read after unmount', async () => {
  let finish!: (status: RuntimeStatus) => void;
  const getRuntime = vi.fn<() => Promise<RuntimeStatus>>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  let state!: ReturnType<typeof useAgentRuntime>;
  const wrapper = mount(
    defineComponent({
      setup() {
        state = useAgentRuntime({ getRuntime });
        return () => null;
      },
    })
  );
  wrapper.unmount();
  finish(initial);
  await flushPromises();
  await vi.advanceTimersByTimeAsync(6000);
  expect(getRuntime).toHaveBeenCalledTimes(1);
  expect(state.lastRuntimeAt.value).toBeNull();
  expect(state.runtime.value.deviceId).toBeNull();
});
it('keeps newer event state when an older HTTP request finishes and cleans up the stream', async () => {
  let finish!: (status: RuntimeStatus) => void;
  let receive!: (status: RuntimeStatus) => void;
  const stop = vi.fn();
  const getRuntime = vi.fn(
    () =>
      new Promise<RuntimeStatus>((resolve) => {
        finish = resolve;
      })
  );
  let state!: ReturnType<typeof useAgentRuntime>;
  const wrapper = mount(
    defineComponent({
      setup() {
        state = useAgentRuntime({
          getRuntime,
          subscribeRuntime: async (callback) => {
            receive = callback;
            return stop;
          },
        });
        return () => null;
      },
    })
  );
  receive({ ...initial, deviceId: 'event' });
  finish(initial);
  await flushPromises();
  expect(state.runtime.value.deviceId).toBe('event');
  wrapper.unmount();
  expect(stop).toHaveBeenCalledOnce();
  receive(initial);
  expect(state.runtime.value.deviceId).toBe('event');
});
