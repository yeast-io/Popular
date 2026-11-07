import type { TaskStatistics } from '../../infrastructure/background-tasks/background-task.types.js';
import { TaskRunner } from '../../infrastructure/background-tasks/task-runner.worker.js';
import type { RemoteDownloadCoordinator } from './remote-download-coordinator.service.js';
import type { RemoteDownloadService } from './remote-download.service.js';

export class RemoteDownloadWorker {
  private readonly runner: TaskRunner;

  constructor(
    readonly service: RemoteDownloadService,
    readonly coordinator?: RemoteDownloadCoordinator,
    statistics?: TaskStatistics
  ) {
    this.runner = new TaskRunner({
      statistics,
      name: 'remote-downloads', intervalMs: 5_000, runOnStart: false,
      logger: service.options.diagnostics?.logger, verbose: service.options.diagnostics?.verbose ?? false,
      run: async ({ signal }) => {
        await service.sweep();
        if (!signal.aborted) await coordinator?.retryQueued();
      },
      onError: (error) => service.options.report(error, { stage: 'remote-download.scan' }),
    });
  }

  start() { this.runner.start(); }

  stop() { return this.runner.stop(); }
}
