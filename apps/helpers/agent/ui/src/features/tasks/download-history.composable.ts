import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { AgentClient } from '../../transport/agent-transport.types';
import type { DownloadHistoryItem } from './download-history.types';

export function useDownloadHistory(client: AgentClient) {
  const items = ref<DownloadHistoryItem[]>([]);
  const loading = ref(false);
  const error = ref(false);
  const limit = ref(20);
  let active = true;
  async function refresh() {
    if (!client.getDownloadHistory || loading.value) return;
    loading.value = true;
    error.value = false;
    try {
      const result = await client.getDownloadHistory();
      if (active) items.value = result;
    } catch {
      if (active) error.value = true;
    } finally {
      if (active) loading.value = false;
    }
  }
  onMounted(() => void refresh());
  onBeforeUnmount(() => {
    active = false;
  });
  return { available: !!client.getDownloadHistory, items, loading, error, limit, refresh };
}
