import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const userSchema = new Schema(
  {
    email: { type: String, required: true, trim: true, lowercase: true },
    displayName: { type: String, required: true, trim: true, maxlength: 80 },
    passwordHash: { type: String, select: false },
    avatarObjectKey: { type: String },
  },
  { timestamps: true, collection: 'users' },
);

userSchema.index({ email: 1 }, { unique: true });

export type UserDocument = InferSchemaType<typeof userSchema>;
export const createUserModel = (connection: Connection) => {
  return connection.model<UserDocument>('User', userSchema);
};
