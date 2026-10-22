import type { RemoteDownloadService } from './remote-download.service.js';

export class RemoteDownloadWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<void> | undefined;

  constructor(readonly service: RemoteDownloadService) {}

  start() {
    this.timer = setInterval(() => {
      if (!this.running)
        this.running = this.service
          .sweep()
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
