import { withAiTrace, type AiTrace } from '../../infrastructure/logging/ai-trace.js';

/** Best-effort, non-overlapping presence updates, independent of answer delivery. */
export function startTyping(
  send: (active: boolean, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  trace: AiTrace,
): () => Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  let stopping: Promise<void> | undefined;
  let stopped = false;
  const update = async (active: boolean, updateSignal: AbortSignal) => {
    try {
      await withAiTrace(trace, () => trace.step('assistant.typing.send', () => send(active, updateSignal), { active }));
    } catch (error) {
      if (!active || !updateSignal.aborted) trace.fail(error, { event: 'assistant_typing_failed', active });
      trace.clearFailure();
    }
  };
  const refresh = () => {
    pending = update(true, controller.signal).finally(() => {
      if (stopped) return;
      timer = setTimeout(refresh, 4_000);
      timer.unref();
    });
  };
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopped = true;
    if (timer) clearTimeout(timer);
    controller.abort();
    signal.removeEventListener('abort', onAbort);
    stopping = pending.then(() => update(false, AbortSignal.timeout(2_000)));
    return stopping;
  };
  const onAbort = () => { void stop(); };
  if (signal.aborted) return async () => undefined;
  signal.addEventListener('abort', onAbort, { once: true });
  refresh();
  return stop;
}
