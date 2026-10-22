// File-backed TEST DOUBLE for process-crash verification, never a production storage adapter.
import { readFile, writeFile } from 'node:fs/promises';
import { MemoryControlStore } from '../../apps/api/src/modules/remote-downloads/testing/memory-control.store.ts';
import { RemoteDownloadService } from '../../apps/api/src/modules/remote-downloads/remote-download.service.ts';

const [mode, file] = process.argv.slice(2);
const data = JSON.parse(await readFile(file, 'utf8'));
const store = new MemoryControlStore();
for (const key of ['accounts', 'devices', 'downloads', 'commands', 'receipts']) {
  for (const [id, row] of data[key]) store[key].set(id, row);
}
const save = () => {
  return writeFile(
    file,
    JSON.stringify(
      Object.fromEntries(['accounts', 'devices', 'downloads', 'commands', 'receipts'].map((k) => [k, [...store[k]]]))
    )
  );
};
const backend = new RemoteDownloadService({ store, report(error) {
  throw error;
}, torrent() {
  throw new Error('NO_NETWORK_EXPECTED');
} });
if (mode === 'commit-crash') {
  store.projectResult = async () => {
    await save();
    process.exit(86);
  };
  await backend.handle('__record_command_result__', data.request);
  throw new Error('MUST_CRASH_BEFORE_ACK');
} else if (mode === 'recover') {
  await backend.sweep();
  await save();
} else throw new Error('INVALID_TEST_MODE');
