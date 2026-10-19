import type { Model } from 'mongoose';
import type { AuthIdentityDocument } from './auth-identity.schema.js';
import type { UserDocument } from './user.schema.js';

export type UserModel = Model<UserDocument>;

export type IdentityModel = Model<AuthIdentityDocument>;
