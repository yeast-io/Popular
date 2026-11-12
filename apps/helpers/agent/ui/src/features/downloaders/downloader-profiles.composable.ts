import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { DownloaderProfile, DownloaderProfilesClient, DownloaderProfileAction } from './downloader-profiles.types';
import type { Snapshot } from '../../settings.types';
import type { DownloaderRequest } from '../../transport/agent-transport.types';

export function useDownloaderProfiles(
  client: DownloaderProfilesClient | undefined,
  apply: (snapshot: Snapshot) => void
) {
  const entries = ref<DownloaderProfile[]>([]);
  const loading = ref(false);
  const loaded = ref(false);
  const error = ref('');
  const editing = ref(false);
  const selectedId = ref<string | null>(null);
  const removingId = ref<string | null>(null);
  const password = ref('');
  const form = reactive<Omit<DownloaderRequest, 'password'>>({
    provider: 'qbittorrent',
    downloaderUrl: 'http://127.0.0.1:8080',
    username: '',
    authMode: 'password',
  });
  let baseline = '';
  let active = true;
  const dirty = computed(() => editing.value && (JSON.stringify(form) !== baseline || !!password.value));
  const selected = computed(() => entries.value.find((row) => row.id === selectedId.value));
  const passwordSaved = computed(
    () =>
      selected.value?.hasPassword
      && ['provider', 'downloaderUrl', 'username', 'authMode'].every(
        (key) => form[key as keyof typeof form] === selected.value?.[key as keyof typeof form]
      )
  );
  function edit(row?: DownloaderProfile) {
    if (loading.value) return;
    selectedId.value = row?.id ?? null;
    Object.assign(
      form,
      row
        ? { provider: row.provider, downloaderUrl: row.downloaderUrl, username: row.username, authMode: row.authMode }
        : { provider: 'qbittorrent', downloaderUrl: 'http://127.0.0.1:8080', username: '', authMode: 'password' }
    );
    password.value = '';
    baseline = JSON.stringify(form);
    editing.value = true;
    error.value = '';
  }
  function cancel() {
    if (!loading.value) {
      editing.value = false;
      password.value = '';
    }
  }
  function code(cause: unknown) {
    return typeof cause === 'string' ? cause : 'unknownError';
  }
  async function load() {
    if (!client || loading.value || dirty.value) return;
    loading.value = true;
    error.value = '';
    try {
      const rows = await client.list();
      if (active) {
        entries.value = rows;
        loaded.value = true;
      }
    } catch (cause) {
      if (active) error.value = code(cause);
    } finally {
      if (active) loading.value = false;
    }
  }
  async function operation(run: () => Promise<Snapshot>, close = false) {
    if (!client || loading.value) return;
    loading.value = true;
    error.value = '';
    try {
      const snapshot = await run();
      if (!active) return;
      apply(snapshot);
      if (close) {
        editing.value = false;
        password.value = '';
      }
      removingId.value = null;
      const rows = await client.list();
      if (active) {
        entries.value = rows;
        loaded.value = true;
      }
    } catch (cause) {
      if (active) error.value = code(cause);
    } finally {
      if (active) loading.value = false;
    }
  }
  function save() {
    if (!client) return;
    const configuration: DownloaderRequest = {
      ...form,
      authMode: form.provider === 'transmission' ? 'password' : form.authMode,
      password: password.value ? { action: 'set', value: password.value } : { action: 'keep' },
    };
    return operation(() => client.configure({ id: selectedId.value, configuration }), true);
  }
  function action(row: DownloaderProfile, operationName: DownloaderProfileAction['operation']) {
    if (!client || editing.value) return;
    return operation(() =>
      client.action({
        id: row.id,
        operation: operationName,
        ...(operationName === 'enabled' ? { enabled: !row.enabled } : {}),
      })
    );
  }
  onMounted(() => void load());
  onBeforeUnmount(() => {
    active = false;
    password.value = '';
  });
  return {
    available: !!client,
    entries,
    loading,
    loaded,
    error,
    editing,
    selectedId,
    removingId,
    form,
    password,
    passwordSaved,
    dirty,
    edit,
    cancel,
    save,
    action,
    load,
  };
}
