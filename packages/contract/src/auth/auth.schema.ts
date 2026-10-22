import { Static, Type } from '@sinclair/typebox';

const EmailSchema = Type.String({ format: 'email', maxLength: 254 });
const PasswordSchema = Type.String({ minLength: 12, maxLength: 128 });

export const RegisterRequestSchema = Type.Object(
  {
    email: EmailSchema,
    password: PasswordSchema,
    displayName: Type.String({ minLength: 1, maxLength: 80 }),
  },
  { additionalProperties: false }
);

export const LoginRequestSchema = Type.Object(
  {
    email: EmailSchema,
    password: PasswordSchema,
  },
  { additionalProperties: false }
);

export const AuthUserSchema = Type.Object(
  {
    id: Type.String(),
    email: EmailSchema,
    displayName: Type.String(),
    avatarUrl: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

export const AuthResponseSchema = Type.Object({ user: AuthUserSchema }, { additionalProperties: false });

export type RegisterRequest = Static<typeof RegisterRequestSchema>;
export type LoginRequest = Static<typeof LoginRequestSchema>;
export type AuthUser = Static<typeof AuthUserSchema>;
export type AuthResponse = Static<typeof AuthResponseSchema>;
