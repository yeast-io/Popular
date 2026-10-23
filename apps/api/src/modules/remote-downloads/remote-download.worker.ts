import { AiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { RemoteDownloadCoordinator } from './remote-download-coordinator.service.js';
import type { RemoteDownloadService } from './remote-download.service.js';

export class RemoteDownloadWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<void> | undefined;

  constructor(readonly service: RemoteDownloadService, readonly coordinator?: RemoteDownloadCoordinator) {}

  start() {
    this.timer = setInterval(() => {
      if (!this.running)
        this.running = withAiTrace(
          new AiTrace(this.service.options.diagnostics?.logger, {}, '', 'remote-queue.sweep',
            this.service.options.diagnostics?.verbose ?? false),
          () => this.service.sweep()
        )
          .then(() => this.coordinator?.retryQueued())
          .catch(
            (error) => this.service.options.report(error, { stage: 'remote-download.scan' })
          )
          .finally(() => {
            this.running = undefined;
          });
    }, 5000);
    this.timer.unref();
  }

  async stop() {
    clearInterval(this.timer);
    await this.running;
  }
}
