import { Type, type Static } from '@sinclair/typebox';
import { LocaleSchema } from '../common/locale.schema.js';
import { WatchlistItemSchema } from '../watchlist/watchlist.schema.js';

export const ResourceNotificationItemSchema = Type.Composite(
  [
    WatchlistItemSchema,
    Type.Object({
      id: Type.String(),
      status: Type.Union([Type.Literal('pending'), Type.Literal('notified')]),
      createdAt: Type.String({ format: 'date-time' }),
      notifiedAt: Type.Optional(Type.String({ format: 'date-time' })),
      lastOutcome: Type.Optional(
        Type.Union([
          Type.Literal('no-channels'),
          Type.Literal('no-resources'),
          Type.Literal('failed'),
          Type.Literal('notified'),
        ])
      ),
    }),
  ],
  { additionalProperties: false }
);
export const ResourceNotificationListSchema = Type.Object(
  {
    items: Type.Array(ResourceNotificationItemSchema, { maxItems: 5 }),
    limit: Type.Integer(),
    locale: LocaleSchema,
  },
  { additionalProperties: false }
);
export const ResourceNotificationMembershipSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    status: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('notified')])),
  },
  { additionalProperties: false }
);
export type ResourceNotificationItem = Static<typeof ResourceNotificationItemSchema>;
export type ResourceNotificationList = Static<typeof ResourceNotificationListSchema>;
export type ResourceNotificationMembership = Static<typeof ResourceNotificationMembershipSchema>;
