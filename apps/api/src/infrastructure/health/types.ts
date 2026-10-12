export interface DependencyHealth {
  status: 'up' | 'down';
  latencyMs: number;
}

export async function timedHealthCheck(check: () => Promise<unknown>): Promise<DependencyHealth> {
  const started = performance.now();
  try {
    await check();
    return { status: 'up', latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { status: 'down', latencyMs: Math.round(performance.now() - started) };
  }
}
