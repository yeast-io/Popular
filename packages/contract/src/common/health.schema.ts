import { Static, Type } from '@sinclair/typebox';

export const DependencyHealthSchema = Type.Object({
  status: Type.Union([Type.Literal('up'), Type.Literal('down')]),
  latencyMs: Type.Integer({ minimum: 0 }),
});

export const LivenessSchema = Type.Object({
  status: Type.Literal('ok'),
  timestamp: Type.String({ format: 'date-time' }),
});

export const ReadinessSchema = Type.Object({
  status: Type.Union([Type.Literal('ok'), Type.Literal('degraded')]),
  timestamp: Type.String({ format: 'date-time' }),
  dependencies: Type.Object({
    mongodb: DependencyHealthSchema,
    redis: DependencyHealthSchema,
    minio: DependencyHealthSchema,
  }),
});

export type Liveness = Static<typeof LivenessSchema>;
export type Readiness = Static<typeof ReadinessSchema>;
