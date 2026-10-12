import type { Model } from 'mongoose';
import type { AuthIdentityDocument } from './auth-identity.schema.js';
import type { UserDocument } from './user.schema.js';
import { DuplicateEmailError, type AuthUserStore, type StoredUser } from '../../modules/auth/auth.types.js';

type UserModel = Model<UserDocument>;
type IdentityModel = Model<AuthIdentityDocument>;

export class MongoAuthUserStore implements AuthUserStore {
  private transactionsSupported: boolean | undefined;

  constructor(private readonly users: UserModel, private readonly identities: IdentityModel) {}

  async createPasswordUser(input: { email: string; displayName: string; passwordHash: string }): Promise<StoredUser> {
    try {
      if (this.transactionsSupported !== false) {
        try {
          const user = await this.createPasswordUserInTransaction(input);
          this.transactionsSupported = true;
          return user;
        } catch (error) {
          if (!isTransactionUnsupported(error)) throw error;
          this.transactionsSupported = false;
        }
      }
      return await this.createPasswordUserWithCompensation(input);
    } catch (error) {
      if (isDuplicateKey(error)) throw new DuplicateEmailError();
      throw error;
    }
  }

  private async createPasswordUserInTransaction(input: { email: string; displayName: string; passwordHash: string }): Promise<StoredUser> {
    let result: StoredUser | undefined;
    await this.users.db.transaction(async (session) => {
      const [user] = await this.users.create([input], { session });
      if (!user) throw new Error('MongoDB did not return the created user');
      await this.identities.create([passwordIdentity(user._id, input.email)], { session });
      result = toStoredUser(user);
    });
    if (!result) throw new Error('Password registration transaction did not complete');
    return result;
  }

  private async createPasswordUserWithCompensation(input: { email: string; displayName: string; passwordHash: string }): Promise<StoredUser> {
    const user = await this.users.create(input);
    try {
      await this.identities.create(passwordIdentity(user._id, input.email));
      return toStoredUser(user);
    } catch (error) {
      try {
        await this.users.deleteOne({ _id: user._id }).exec();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Auth identity creation and user cleanup both failed');
      }
      throw error;
    }
  }

  async findByEmailWithPassword(email: string): Promise<StoredUser | null> {
    const user = await this.users.findOne({ email }).select('+passwordHash').exec();
    return user?.passwordHash ? toStoredUser(user) : null;
  }

  async findById(id: string): Promise<StoredUser | null> {
    const user = await this.users.findById(id).select('+passwordHash').exec();
    return user?.passwordHash ? toStoredUser(user) : null;
  }


  async updateDisplayName(id: string, displayName: string): Promise<StoredUser | null> {
    const user = await this.users.findByIdAndUpdate(id, { $set: { displayName } }, { new: true }).select('+passwordHash').exec();
    return user ? toStoredUser(user) : null;
  }

  async updateAvatarObjectKey(id: string, avatarObjectKey: string | undefined): Promise<StoredUser | null> {
    const update = avatarObjectKey
      ? { $set: { avatarObjectKey } }
      : { $unset: { avatarObjectKey: 1 } };
    const user = await this.users.findByIdAndUpdate(id, update, { new: true }).select('+passwordHash').exec();
    return user ? toStoredUser(user) : null;
  }
}

function toStoredUser(user: UserDocument & { _id: unknown }): StoredUser {
  return {
    id: String(user._id),
    email: user.email,
    displayName: user.displayName,
    passwordHash: user.passwordHash ?? '',
    ...(user.avatarObjectKey ? { avatarObjectKey: user.avatarObjectKey } : {}),
  };
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

function isTransactionUnsupported(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (
    ('code' in error && error.code === 20)
    || ('message' in error && typeof error.message === 'string' && error.message.includes('Transaction numbers are only allowed'))
  );
}

function passwordIdentity(ownerId: unknown, email: string) {
  return {
    ownerId,
    provider: 'password' as const,
    providerSubject: email,
    providerEmail: email,
  };
}
