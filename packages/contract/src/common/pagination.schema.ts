import { Static, Type } from '@sinclair/typebox';

export const PaginationQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
});

export const PaginationMetaSchema = Type.Object({
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1 }),
  total: Type.Integer({ minimum: 0 }),
  hasMore: Type.Boolean(),
});

export type PaginationQuery = Static<typeof PaginationQuerySchema>;
export type PaginationMeta = Static<typeof PaginationMetaSchema>;
