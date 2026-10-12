import { ApiErrorSchema, LivenessSchema, ReadinessSchema } from '@movie-hub/contract';
import type { FastifyInstance } from 'fastify';
import type { HealthDependency } from '../../infrastructure/health/dependency.js';

export function registerHealthRoutes(app: FastifyInstance, dependencies: HealthDependency[]): void {
  app.get('/health/live', {
    schema: { response: { 200: LivenessSchema } },
  }, async () => ({ status: 'ok' as const, timestamp: new Date().toISOString() }));

  app.get('/health/ready', {
    schema: { response: { 200: ReadinessSchema, 503: ReadinessSchema, 500: ApiErrorSchema } },
  }, async (_request, reply) => {
    const checks = await Promise.all(dependencies.map(async (dependency) => [dependency.name, await dependency.check()] as const));
    const byName = Object.fromEntries(checks) as Record<HealthDependency['name'], Awaited<ReturnType<HealthDependency['check']>>>;
    const dependenciesResult = {
      mongodb: byName.mongodb ?? { status: 'down' as const, latencyMs: 0 },
      redis: byName.redis ?? { status: 'down' as const, latencyMs: 0 },
      minio: byName.minio ?? { status: 'down' as const, latencyMs: 0 },
    };
    const healthy = Object.values(dependenciesResult).every(({ status }) => status === 'up');
    if (!healthy) reply.status(503);
    return {
      status: healthy ? 'ok' as const : 'degraded' as const,
      timestamp: new Date().toISOString(),
      dependencies: dependenciesResult,
    };
  });
}
