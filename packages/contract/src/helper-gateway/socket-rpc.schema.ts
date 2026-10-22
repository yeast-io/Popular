import { Type, type Static } from '@sinclair/typebox';

export const RpcIdSchema = Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9_-]+$' });
export const RpcFrameSchema = Type.Object({ protocolVersion: Type.Literal(1),
  command: Type.String({ pattern: '^__[a-z_]+__$', maxLength: 100 }), messageId: RpcIdSchema,
  replyTo: Type.Optional(RpcIdSchema), correlationId: RpcIdSchema, payload: Type.Unknown(),
}, { additionalProperties: false });
export const RpcResultSchema = Type.Union([
  Type.Object({ requestCommand: Type.String(), ok: Type.Literal(true), data: Type.Unknown() }, { additionalProperties: false }),
  Type.Object({ requestCommand: Type.String(), ok: Type.Literal(false), error: Type.Object({
    code: Type.String({ pattern: '^[A-Z0-9_]+$', maxLength: 100 }), retryable: Type.Boolean(),
    effect: Type.Union([Type.Literal('not_applied'), Type.Literal('unknown')]),
  }, { additionalProperties: false }) }, { additionalProperties: false }),
]);
export type RpcResult = Static<typeof RpcResultSchema>;
