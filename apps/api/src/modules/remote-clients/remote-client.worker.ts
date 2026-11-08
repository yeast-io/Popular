import type { TaskStatistics } from '../../infrastructure/background-tasks/background-task.types.js';
import { TaskRunner } from '../../infrastructure/background-tasks/task-runner.worker.js';
import { aiStep } from '../../infrastructure/logging/ai-trace.js';
import { REMOTE_CLIENT_MAINTENANCE_SCAN_MS } from './remote-client.policy.js';
import type { RemoteClientService } from './remote-client.service.js';
import type { RemoteClientDiagnostics } from './remote-client.types.js';

export class RemoteClientWorker {
  private lastStatusSync = 0;
  private readonly runner: TaskRunner;

  constructor(service: RemoteClientService, diagnostics: RemoteClientDiagnostics, statistics?: TaskStatistics) {
    this.runner = new TaskRunner({
      statistics,
      name: 'remote-client-maintenance', intervalMs: REMOTE_CLIENT_MAINTENANCE_SCAN_MS,
      logger: diagnostics.logger, verbose: diagnostics.verbose,
      run: async ({ signal }) => {
        await aiStep('remote-client.notification-retry', () => service.retryNotifications(diagnostics));
        if (!signal.aborted && Date.now() - this.lastStatusSync >= 60_000) {
          this.lastStatusSync = Date.now();
          await aiStep('remote-client.status-sync', async () => service.syncStatuses?.());
        }
      },
    });
  }

  start() { this.runner.start(); }

  tick() { return this.runner.tick(); }

  stop() { return this.runner.stop(); }
}
