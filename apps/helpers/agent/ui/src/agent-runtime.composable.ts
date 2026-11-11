import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { RuntimeStatus } from './settings.types';
import type { AgentClient } from './transport/agent-transport.types';

export function useAgentRuntime(client: Pick<AgentClient, 'getRuntime' | 'subscribeRuntime'>) {
  const runtime = ref<RuntimeStatus>({
    service: 'unconfigured',
    downloader: 'disconnected',
    deviceId: null,
    binding: 'unbound',
    preferenceError: null,
  });
  const runtimeFailed = ref(false);
  const lastRuntimeAt = ref<number | null>(null);
  let active = true;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let stopSubscription: (() => void) | undefined;

  async function refreshRuntime(afterAction = false): Promise<void> {
    if (afterAction) {
      ++revision;
      await pending;
    } else if (pending) return pending;
    if (!active) return;
    const current = revision;
    pending = client
      .getRuntime()
      .then((value) => {
        if (!active || current !== revision) return;
        runtime.value = value;
        runtimeFailed.value = false;
        lastRuntimeAt.value = Date.now();
      })
      .catch(() => {
        if (active && current === revision) runtimeFailed.value = true;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }
  async function poll() {
    await refreshRuntime();
    if (active) timer = setTimeout(() => void poll(), 2000);
  }
  onMounted(() => {
    void poll();
    if (client.subscribeRuntime)
      void client
        .subscribeRuntime(
          (value) => {
            if (!active) return;
            ++revision;
            runtime.value = value;
            runtimeFailed.value = false;
            lastRuntimeAt.value = Date.now();
          },
          () => {
            if (active) runtimeFailed.value = true;
          }
        )
        .then((stop) => {
          if (active) stopSubscription = stop;
          else stop();
        })
        .catch(() => {
          if (active) runtimeFailed.value = true;
        });
  });
  onBeforeUnmount(() => {
    active = false;
    ++revision;
    clearTimeout(timer);
    stopSubscription?.();
  });
  return { runtime, runtimeFailed, lastRuntimeAt, refreshRuntime };
}
