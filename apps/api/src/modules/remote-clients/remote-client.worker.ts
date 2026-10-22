import { randomUUID } from 'node:crypto';
import { AiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { RemoteClientService } from './remote-client.service.js';
import type { RemoteClientDiagnostics } from './remote-client.types.js';

export class RemoteClientWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<void> | undefined;

  constructor(private readonly service: RemoteClientService, private readonly diagnostics: RemoteClientDiagnostics) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 5000);
    this.timer.unref();
    void this.tick();
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    const trace = new AiTrace(
      this.diagnostics.logger,
      { correlationId: randomUUID() },
      '',
      'remote-client.notification-retry',
      this.diagnostics.verbose
    );
    this.running = withAiTrace(trace, async () => {
      try {
        await trace.step('remote-client.notification-retry', () => this.service.retryNotifications(this.diagnostics));
      } catch (error) {
        trace.fail(error);
      }
    }).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }
}
