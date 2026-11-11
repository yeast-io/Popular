import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { AgentClient } from '../../transport/agent-transport.types';
import type { QueueView } from './queue.types';

export function useTaskQueue(client: AgentClient) {
  const view = ref<QueueView>({ snapshot: null, stale: true, loading: true });
  const error = ref(false);
  const changing = ref(false);
  const now = ref(Date.now());
  let active = true;
  let revision = 0;
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function refresh() {
    if (pending) return pending;
    if (!active) return;
    const current = revision;
    now.value = Date.now();
    pending = client
      .getQueue()
      .then((value) => {
        if (!active || current !== revision) return;
        view.value = value;
        error.value = false;
      })
      .catch(() => {
        if (active && current === revision) {
          error.value = true;
          view.value = { ...view.value, stale: true, loading: false };
        }
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }
  async function page(cursor: string | null) {
    if (changing.value || !active) return;
    changing.value = true;
    ++revision;
    try {
      await pending;
      if (!active) return;
      await client.setQueuePage(cursor);
      if (active) await refresh();
    } catch {
      if (active) {
        error.value = true;
        view.value = { ...view.value, stale: true, loading: false };
      }
    } finally {
      if (active) changing.value = false;
    }
  }
  async function poll() {
    if (!changing.value) await refresh();
    if (active) timer = setTimeout(() => void poll(), 2000);
  }
  onMounted(() => void poll());
  onBeforeUnmount(() => {
    active = false;
    ++revision;
    clearTimeout(timer);
  });
  return { view, error, changing, now, refresh, page };
}
