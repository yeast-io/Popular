import type { AiLogger } from '../logging/ai-trace.js';
import { serializeDiagnosticError } from '../logging/diagnostic-error.js';

type Cleanup = { name: string; order: number; close: () => void | Promise<void> };

/** One shutdown path for signals, fatal errors, startup failure and natural exit. */
export class ApplicationShutdown {
  private readonly resources: Cleanup[] = [];
  private running?: Promise<void>;
  private closing = false;
  private failed = false;
  private currentResource = 'startup';

  constructor(
    private readonly logger: AiLogger,
    private readonly startupSettled: Promise<void>,
    private readonly timeoutMs: number
  ) {}

  get requested(): boolean { return this.closing; }
  get exitCode(): number { return this.failed ? 1 : 0; }

  register(name: string, order: number, close: Cleanup['close']): void {
    this.resources.push({ name, order, close });
  }

  assertRunning(): void {
    if (this.closing) throw new Error('Application is shutting down');
  }

  shutdown(reason: string, error?: unknown): Promise<void> {
    if (error !== undefined) {
      this.failed = true;
      this.logger.error({ event: 'shutdown_fatal_error', reason, error: serializeDiagnosticError(error) }, 'Application fatal error');
    }
    if (this.running) return this.running;
    this.closing = true;
    this.logger.info?.({ event: 'shutdown_started', reason, timeoutMs: this.timeoutMs }, 'Application shutdown started');
    this.running = this.run();
    return this.running;
  }

  private async run(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        this.failed = true;
        this.logger.error({ event: 'shutdown_timeout', resource: this.currentResource, timeoutMs: this.timeoutMs }, 'Shutdown deadline exceeded; remaining leases must expire');
        resolve();
      }, this.timeoutMs);
    });
    try {
      await Promise.race([this.closeResources(), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      this.logger.info?.({ event: 'shutdown_completed', exitCode: this.exitCode }, 'Application shutdown finished');
    }
  }

  private async closeResources(): Promise<void> {
    // A signal during bootstrap must not close connectors while they are still being created.
    await this.startupSettled;
    for (const resource of this.resources.sort((a, b) => a.order - b.order)) {
      this.currentResource = resource.name;
      const started = Date.now();
      this.logger.info?.({ event: 'resource_closing', resource: resource.name }, 'Closing application resource');
      try {
        await resource.close();
        this.logger.info?.({ event: 'resource_closed', resource: resource.name, durationMs: Date.now() - started }, 'Application resource closed');
      } catch (error) {
        this.failed = true;
        this.logger.error({ event: 'resource_close_failed', resource: resource.name, error: serializeDiagnosticError(error) }, 'Application resource close failed');
      }
    }
  }
}

export function installShutdownHandlers(shutdown: ApplicationShutdown, host: NodeJS.Process = process, flush: () => Promise<void> = async () => undefined): { request: (reason: string, error?: unknown) => void; dispose: () => void } {
  let exiting = false;
  const request = (reason: string, error?: unknown) => {
    const completed = shutdown.shutdown(reason, error);
    if (exiting) return;
    exiting = true;
    void completed.then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([flush(), new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); })]);
      } catch { /* Resource cleanup is complete; logging must not block exit. */ }
      finally { if (timer) clearTimeout(timer); host.exit(shutdown.exitCode); }
    }, () => { host.exit(1); });
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGUSR2'] as const;
  const listeners = signals.map(signal => {
    const listener = () => request(signal);
    host.on(signal, listener);
    return { signal, listener };
  });
  const uncaught = (error: Error) => request('uncaughtException', error);
  const rejected = (error: unknown) => request('unhandledRejection', error ?? new Error('Unhandled rejection'));
  const beforeExit = (code: number) => request('beforeExit', code === 0 ? undefined : new Error(`Process exiting with code ${code}`));
  const disconnected = () => request('disconnect');
  host.on('uncaughtException', uncaught);
  host.on('unhandledRejection', rejected);
  host.on('beforeExit', beforeExit);
  host.on('disconnect', disconnected);
  // The exit event cannot await cleanup; SIGKILL/SIGSTOP cannot be intercepted.
  return { request, dispose: () => {
    for (const { signal, listener } of listeners) host.off(signal, listener);
    host.off('uncaughtException', uncaught);
    host.off('unhandledRejection', rejected);
    host.off('beforeExit', beforeExit);
    host.off('disconnect', disconnected);
  } };
}
