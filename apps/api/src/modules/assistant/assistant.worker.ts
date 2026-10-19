import type { AssistantWorkerOptions } from './assistant.types.js';
import { loadTmdbPoster } from '../../infrastructure/tmdb/poster.js';
import type { RecommendationMovie } from '../recommendations/recommendation.types.js';
import { RedisLockTrace } from '../../infrastructure/redis/lock-trace.js';
import { AiTrace, aiStep, currentAiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import { serializeDiagnosticError } from '../../infrastructure/logging/diagnostic-error.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { AssistantConversation, AssistantJob, AssistantQueue } from './assistant.types.js';
import type { AssistantWorkflow } from './assistant.workflow.js';
import type { AssistantInputWorkflowMessage } from './assistant.types.js';
import { startTyping } from './assistant.typing.js';

// Shared slots cap concurrency across API instances. All instances must use the same limit.
const PREFIX = '{assistant}:worker';
const RENEW = `
if redis.call('get',KEYS[1]) ~= ARGV[1] or redis.call('get',KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('expire',KEYS[1],60)
redis.call('expire',KEYS[2],60)
return 1`;
const RELEASE = "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) end return 0";

/** Durable messages are authoritative; wakeups only reduce pickup latency. */
export class AssistantWorker {
  private stopped = true;
  private readonly lockTrace: RedisLockTrace;
  private timer?: ReturnType<typeof setTimeout>;
  private scanning?: Promise<void>;
  private readonly pending = new Map<string, AssistantConversation>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly controllers = new Set<AbortController>();

  constructor(
    private readonly redis: Pick<Redis, 'set' | 'eval' | 'ttl'>,
    private readonly queue: AssistantQueue,
    private readonly workflow: Pick<AssistantWorkflow, 'run'>,
    private readonly send: (input: AssistantInputWorkflowMessage, text: string, poster?: Buffer) => Promise<unknown>,
    private readonly isBound: (input: AssistantInputWorkflowMessage) => Promise<boolean>,
    private readonly report: (event: string) => void,
    private readonly options: AssistantWorkerOptions = { maxConcurrency: 4, scanIntervalMs: 15_000 },
    private readonly logger?: AiLogger,
    private readonly lockTraceEnabled = false,
    private readonly poster: (path: string, signal?: AbortSignal) => Promise<Buffer | undefined> = loadTmdbPoster
  ) {
    this.lockTrace = new RedisLockTrace(lockTraceEnabled, logger, (key) => this.redis.ttl(key));
    if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1 || options.scanIntervalMs < 1) {
      throw new Error('Invalid assistant worker limits');
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.logger?.info?.({ event: 'assistant_worker_started', ...this.options }, 'Assistant worker started');
    this.pump();
    this.scan();
  }

  /** Synchronous notification: receiving transports never await generation or delivery. */
  wake(conversation: AssistantConversation, source: 'message' | 'scan' = 'message'): void {
    const key = createHash('sha256')
      .update(JSON.stringify([conversation.ownerId, conversation.channel, conversation.chatId]))
      .digest('hex');
    this.pending.set(key, {
      ownerId: conversation.ownerId,
      channel: conversation.channel,
      chatId: conversation.chatId,
    });
    if (source !== 'scan' || this.options.scanTraceEnabled)
      this.logger?.info?.(
        {
          event: 'assistant_wake',
          ...this.pending.get(key),
          stopped: this.stopped,
          runningCount: this.running.size,
          pendingCount: this.pending.size,
        },
        'Assistant wake received',
      );
    this.pump();
  }

  private pump(): void {
    if (this.stopped) return;
    for (const [key, conversation] of this.pending) {
      if (this.running.size >= this.options.maxConcurrency) break;
      if (this.running.has(key)) continue;
      this.pending.delete(key);
      const task = this.drain(key, conversation)
        .catch((error) => {
          this.logger?.error(
            { event: 'assistant_worker_failed', ...conversation, error: serializeDiagnosticError(error) },
            'Assistant worker failed',
          );
          this.report('assistant_worker_failed');
        })
        .finally(() => {
          this.running.delete(key);
          this.pump();
        });
      this.running.set(key, task);
    }
  }

  private scan(): void {
    this.scanning = this.tick()
      .catch((error) => {
        this.logger?.error(
          { event: 'assistant_scan_failed', error: serializeDiagnosticError(error) },
          'Assistant recovery scan failed',
        );
        this.report('assistant_scan_failed');
      })
      .finally(() => {
        if (this.stopped) return;
        this.timer = setTimeout(() => this.scan(), this.options.scanIntervalMs);
        this.timer.unref();
      });
  }

  /** Recovery and direct wakeups converge on drain(), including its atomic claim(). */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const conversations = await this.queue.readyConversations(100);
    if (this.options.scanTraceEnabled)
      this.logger?.info?.(
        { event: 'assistant_scan_completed', readyConversations: conversations.length },
        'Assistant recovery scan completed',
      );
    for (const conversation of conversations) {
      if (this.stopped) return;
      this.wake(conversation, 'scan');
    }
  }

  private async drain(key: string, conversation: AssistantConversation): Promise<void> {
    const leaseId = randomUUID();
    const lock = `${PREFIX}:conversation:${key}`;
    let slot: string | undefined;
    const controller = new AbortController();
    this.controllers.add(controller);
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let renewing: Promise<void> | undefined;
    let job: AssistantJob | null = null;
    const renew = async (): Promise<void> => {
      controller.signal.throwIfAborted();
      if (
        (await this.lockTrace.run('renew', [lock, slot!], () => this.redis.eval(RENEW, 2, lock, slot!, leaseId), {
          lockTypes: ['assistant_conversation', 'assistant_capacity'],
          ...conversation,
          jobId: job?.id,
          leaseSeconds: 60,
        }
        )) !== 1
      ) {
        throw new Error('Assistant conversation or concurrency lease lost');
      }
      const currentJob = job;
      if (currentJob && !(await this.queue.renew(currentJob.id, leaseId)) && job === currentJob) {
        throw new Error('Assistant message lease lost');
      }
      controller.signal.throwIfAborted();
    };
    const beat = (): void => {
      heartbeat = setTimeout(() => {
        renewing = renew()
          .catch((error) => {
            this.logger?.error(
              {
                event: 'assistant_lease_renew_failed',
                ...conversation,
                jobId: job?.id,
                error: serializeDiagnosticError(error),
              },
              'Assistant lease renewal failed',
            );
            controller.abort();
          })
          .finally(() => {
            if (!controller.signal.aborted) beat();
          });
      }, 15_000
      );
      heartbeat.unref();
    };
    try {
      if (
        (await this.lockTrace.run(
          'acquire',
          [lock],
          () => {
            return this.redis.set(lock, leaseId, 'EX', 60, 'NX');
          },
          { lockType: 'assistant_conversation', ...conversation, leaseSeconds: 60 },
        )) !== 'OK'
      ) {
        return;
      }
      for (let index = 0; index < this.options.maxConcurrency; index++) {
        const candidate = `${PREFIX}:slot:${index}`;
        if (
          (await this.lockTrace.run(
            'acquire',
            [candidate],
            () => {
              return this.redis.set(candidate, leaseId, 'EX', 60, 'NX');
            },
            { lockType: 'assistant_capacity', ...conversation, slot: index, leaseSeconds: 60 },
          )) === 'OK'
        ) {
          slot = candidate;
          break;
        }
      }
      if (!slot) {
        if (this.lockTraceEnabled)
          this.logger?.info?.(
            { event: 'assistant_capacity_busy', ...conversation },
            'Assistant shared concurrency limit reached',
          );
        return;
      }
      beat();
      while (!this.stopped && !controller.signal.aborted) {
        await renew();
        job = await this.queue.claim(conversation, leaseId);
        if (!job) {
          if (this.options.scanTraceEnabled)
            this.logger?.info?.(
              { event: 'assistant_claim_empty', ...conversation },
              'No due conversation head to claim',
            );
          return;
        }
        const currentJob = job;
        const trace = new AiTrace(
          this.logger,
          {
            event: 'assistant_job',
            ...conversation,
            messageId: job.input.messageId,
            jobId: job.id,
            attempt: job.attempts,
          },
          job.input.text,
          'assistant.job',
          this.options.verbose ?? false,
        );
        trace.event('assistant.job.claimed', { reusedReply: Boolean(job.result) });
        const finishRenewal = async (): Promise<void> => {
          job = null;
          await renewing;
        };
        const deadline = setTimeout(() => controller.abort(), 240_000);
        deadline.unref();
        try {
          await withAiTrace(trace, () => {
            return this.execute(currentJob, leaseId, controller.signal, renew, finishRenewal);
          });
        } catch (error) {
          trace.fail(error, { aborted: controller.signal.aborted, exhausted: currentJob.attempts >= 5 });
          this.report('assistant_delivery_or_execution_failed');
          await finishRenewal();
          try {
            await trace.step('assistant.job.retry', () => {
              return this.queue.retry(currentJob.id, leaseId, currentJob.attempts >= 5);
            });
          } catch (retryError) {
            trace.fail(retryError);
            throw new Error('Assistant retry scheduling failed; see correlated job error', { cause: retryError });
          }
          return;
        } finally {
          clearTimeout(deadline);
          // A renewal already in flight must finish before the next job replaces this one.
          await renewing;
          job = null;
        }
      }
    } finally {
      controller.abort();
      if (heartbeat) clearTimeout(heartbeat);
      await renewing;
      this.controllers.delete(controller);
      // Token checks prevent an expired owner from releasing a replacement worker's locks.
      const released = await Promise.allSettled([
        this.lockTrace.run(
          'release',
          [lock],
          () => {
            return this.redis.eval(RELEASE, 1, lock, leaseId);
          },
          { lockType: 'assistant_conversation', ...conversation },
        ),
        ...(slot
          ? [
              this.lockTrace.run(
                'release',
                [slot],
                () => {
                  return this.redis.eval(RELEASE, 1, slot!, leaseId);
                },
                { lockType: 'assistant_capacity', ...conversation },
              ),
            ]
          : []),
      ]);
      for (const result of released) {
        if (result.status === 'rejected') {
          this.logger?.error(
            {
              event: 'assistant_lease_release_failed',
              ...conversation,
              error: serializeDiagnosticError(result.reason),
            },
            'Assistant lease release failed',
          );
          this.report('assistant_lease_release_failed');
        }
      }
    }
  }

  private async execute(
    job: AssistantJob,
    leaseId: string,
    signal: AbortSignal,
    renew: () => Promise<void>,
    finishRenewal: () => Promise<void>,
  ): Promise<void> {
    signal.throwIfAborted();
    if (!(await aiStep('assistant.binding.check', () => this.isBound(job.input)))) {
      await finishRenewal();
      currentAiTrace()?.event('assistant.binding.rejected');
      await aiStep('assistant.job.cancel', () => this.queue.retry(job.id, leaseId, true));
      return;
    }
    const stopTyping = this.options.setTyping
      ? startTyping(
          (active, updateSignal) => {
            return this.options.setTyping!(job.input, active, updateSignal);
          },
          signal,
          new AiTrace(
            this.logger,
            {
              event: 'assistant_typing',
              ownerId: job.input.ownerId,
              channel: job.input.channel,
              chatId: job.input.chatId,
              messageId: job.input.messageId,
              jobId: job.id,
              attempt: job.attempts,
              correlationId: currentAiTrace()?.correlationId,
            },
            job.input.text,
            'assistant.typing',
            this.options.verbose ?? false,
          ),
        )
      : async () => undefined;
    try {
      await this.executeWithTyping(job, leaseId, signal, renew, finishRenewal);
    } finally {
      await stopTyping();
    }
  }

  private async executeWithTyping(
    job: AssistantJob,
    leaseId: string,
    signal: AbortSignal,
    renew: () => Promise<void>,
    finishRenewal: () => Promise<void>,
  ): Promise<void> {
    let result = job.result;
    if (!result) {
      try {
        const history = await aiStep('assistant.history.load', () => this.queue.history(job.input));
        for (const message of history) currentAiTrace()?.sensitive(message.content);
        result = await aiStep('assistant.workflow.run', () => {
          return this.workflow.run(job.input, history, signal);
        });
      } catch (error) {
        signal.throwIfAborted();
        currentAiTrace()?.fail(error, { event: 'assistant_generation_failed' });
        currentAiTrace()?.clearFailure();
        this.report('assistant_generation_failed');
        result = { replyText: errorReply(error) };
      }
      signal.throwIfAborted();
      currentAiTrace()?.sensitive(result.replyText);
      if (
        !(await aiStep('assistant.result.save', () => {
          return this.queue.saveResult(job.id, leaseId, result!);
        }))
      )
        throw new Error('Assistant result lease lost');
    }
    currentAiTrace()?.sensitive(result.replyText);
    if (this.lockTraceEnabled) await aiStep('assistant.lease.check', renew);
    else await renew();
    // Recheck binding after the potentially slow model call.
    if (!(await aiStep('assistant.binding.check', () => this.isBound(job.input)))) {
      await finishRenewal();
      currentAiTrace()?.event('assistant.binding.rejected');
      await aiStep('assistant.job.cancel', () => this.queue.retry(job.id, leaseId, true));
      return;
    }
    signal.throwIfAborted();
    if (result.movies?.length) {
      for (let index = job.deliveredMovieCount ?? 0; index < result.movies.length; index++) {
        await this.sendMovie(job, result.movies[index]!, index, signal, renew);
        await aiStep(
          'assistant.movie.checkpoint',
          async () => {
            if (!(await this.queue.markMovieDelivered(job.id, leaseId, index + 1)))
              throw new Error('Assistant movie delivery lease lost');
          },
          { movieIndex: index, tmdbId: result.movies[index]!.tmdbId },
        );
      }
    } else {
      await aiStep('assistant.reply.send', () => this.send(job.input, result!.replyText));
    }
    await finishRenewal();
    await aiStep('assistant.job.delivered', () => this.queue.delivered(job.id, leaseId));
  }

  private async sendMovie(
    job: AssistantJob,
    movie: RecommendationMovie,
    index: number,
    signal: AbortSignal,
    renew: () => Promise<void>,
  ): Promise<void> {
    const fields = { tmdbId: movie.tmdbId, movieIndex: index, attempt: job.attempts };
    // At most 800 UTF-16 units for the title/reason, leaving room for the index and link in a Telegram caption.
    const caption = `${index + 1}. ${[...movie.title].slice(0, 180).join('')}\n${[...movie.reason].slice(0, 220).join('')}\nhttps://www.themoviedb.org/movie/${movie.tmdbId}`;
    currentAiTrace()?.sensitive(caption);
    const check = async () => {
      signal.throwIfAborted();
      await renew();
      if (!(await aiStep('assistant.movie.binding.check', () => this.isBound(job.input), fields)))
        throw new Error('Assistant binding changed');
      signal.throwIfAborted();
    };
    await check();
    let poster: Buffer | undefined;
    if (movie.posterPath) {
      try {
        poster = await aiStep(
          'assistant.movie.poster.load',
          () => {
            return this.poster(movie.posterPath!, signal);
          },
          fields,
        );
      } catch (error) {
        currentAiTrace()?.fail(error, { ...fields, outcome: 'text_fallback' });
        currentAiTrace()?.clearFailure();
        signal.throwIfAborted();
      }
    }
    if (poster?.length) {
      await check();
      try {
        await aiStep(
          'assistant.movie.photo.send',
          () => {
            return this.send(job.input, caption, poster);
          },
          fields,
        );
        return;
      } catch (error) {
        currentAiTrace()?.fail(error, { ...fields, outcome: 'text_fallback' });
        currentAiTrace()?.clearFailure();
        signal.throwIfAborted();
      }
    }
    await check();
    currentAiTrace()?.event('assistant.movie.text_fallback', { ...fields, outcome: 'text' });
    await aiStep('assistant.movie.text.send', () => this.send(job.input, caption), fields);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.pending.clear();
    for (const controller of this.controllers) controller.abort();
    await this.scanning;
    await Promise.all(this.running.values());
  }
}

function errorReply(error: unknown): string {
  if (
    error instanceof AppError &&
    ['OPENAI_NOT_CONFIGURED', 'OPENAI_AUTH_FAILED', 'OPENAI_QUOTA_EXCEEDED', 'OPENAI_RATE_LIMITED'].includes(error.code)
  ) {
    return 'AI 暂时不可用，请在系统设置中检查你自己的 OpenAI API Key、额度和调用限制。';
  }
  return '本次 AI 处理未完成，请稍后重新发送消息。没有执行任何资源查询或下载操作。';
}
