import { Static, Type } from '@sinclair/typebox';
import { ErrorCodeSchema } from '../common/error.schema.js';

const objectIdPattern = '^[0-9a-fA-F]{24}$';

export const ConversationParamsSchema = Type.Object({
  threadId: Type.String({ pattern: objectIdPattern }),
}, { additionalProperties: false });

export const ConversationMessagesQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
}, { additionalProperties: false });

export const AppendConversationMessageRequestSchema = Type.Object({
  content: Type.String({ minLength: 1, maxLength: 20_000 }),
  clientRequestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
}, { additionalProperties: false });

export const RunConversationTurnRequestSchema = Type.Object({
  content: Type.String({ minLength: 1, maxLength: 20_000 }),
  clientRequestId: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });

export const ConversationThreadSchema = Type.Object({
  id: Type.String({ pattern: objectIdPattern }),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
  status: Type.Union([Type.Literal('active'), Type.Literal('archived')]),
  nextSequence: Type.Integer({ minimum: 1 }),
  lastMessageAt: Type.Optional(Type.String({ format: 'date-time' })),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false });

export const ConversationMessageSchema = Type.Object({
  id: Type.String({ pattern: objectIdPattern }),
  threadId: Type.String({ pattern: objectIdPattern }),
  sequence: Type.Integer({ minimum: 1 }),
  role: Type.Union([Type.Literal('user'), Type.Literal('assistant'), Type.Literal('system')]),
  content: Type.String(),
  clientRequestId: Type.Optional(Type.String()),
  createdAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false });

export const ConversationMessagesResponseSchema = Type.Object({
  items: Type.Array(ConversationMessageSchema),
}, { additionalProperties: false });

export const ConversationThreadsResponseSchema = Type.Object({
  items: Type.Array(ConversationThreadSchema),
}, { additionalProperties: false });

export const ConversationTurnResponseSchema = Type.Object({
  userMessage: ConversationMessageSchema,
  assistantMessage: ConversationMessageSchema,
  usage: Type.Object({
    inputTokens: Type.Integer({ minimum: 0 }),
    outputTokens: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export const ConversationTurnStreamEventSchema = Type.Union([
  Type.Object({
    type: Type.Literal('user_message'),
    message: ConversationMessageSchema,
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('delta'),
    delta: Type.String(),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('completed'),
    assistantMessage: ConversationMessageSchema,
    usage: Type.Object({
      inputTokens: Type.Integer({ minimum: 0 }),
      outputTokens: Type.Integer({ minimum: 0 }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('error'),
    error: Type.Object({
      code: ErrorCodeSchema,
      message: Type.String(),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);

export type ConversationParams = Static<typeof ConversationParamsSchema>;
export type ConversationMessagesQuery = Static<typeof ConversationMessagesQuerySchema>;
export type AppendConversationMessageRequest = Static<typeof AppendConversationMessageRequestSchema>;
export type RunConversationTurnRequest = Static<typeof RunConversationTurnRequestSchema>;
export type ConversationThreadResponse = Static<typeof ConversationThreadSchema>;
export type ConversationMessageResponse = Static<typeof ConversationMessageSchema>;
export type ConversationMessagesResponse = Static<typeof ConversationMessagesResponseSchema>;
export type ConversationThreadsResponse = Static<typeof ConversationThreadsResponseSchema>;
export type ConversationTurnResponse = Static<typeof ConversationTurnResponseSchema>;
export type ConversationTurnStreamEvent = Static<typeof ConversationTurnStreamEventSchema>;
