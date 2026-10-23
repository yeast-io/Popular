import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from 'mongoose';
import { DuplicateEmailError } from '../../../modules/auth/auth.errors.js';
import type { AuthIdentityDocument } from './auth-identity.schema.js';
import { MongoAuthUserStore } from './user.store.js';
import type { UserDocument } from './user.schema.js';

interface HarnessOptions {
  identityError?: Error;
  userError?: Error & { code?: number };
}

function standaloneHarness(options: HarnessOptions = {}) {
  let transactionAttempts = 0;
  let userCreates = 0;
  let identityCreates = 0;
  let userDeletes = 0;

  const users = {
    db: {
      transaction: async () => {
        transactionAttempts += 1;
        const error = new Error('Transaction numbers are only allowed on a replica set member or mongos') as Error & {
          code: number;
        };
        error.code = 20;
        throw error;
      },
    },
    create: async (input: { email: string; displayName: string; passwordHash: string }) => {
      userCreates += 1;
      if (options.userError) throw options.userError;
      return { _id: `user-${userCreates}`, ...input };
    },
    deleteOne: () => ({
      exec: async () => {
        userDeletes += 1;
      },
    }),
  } as unknown as Model<UserDocument>;

  const identities = {
    create: async () => {
      identityCreates += 1;
      if (options.identityError) throw options.identityError;
      return {};
    },
  } as unknown as Model<AuthIdentityDocument>;

  return {
    store: new MongoAuthUserStore(users, identities),
    counts: () => ({ transactionAttempts, userCreates, identityCreates, userDeletes }),
  };
}

const input = { email: 'person@example.com', displayName: 'Person', passwordHash: 'hash' };

test('standalone MongoDB falls back once to compensated registration', async () => {
  const harness = standaloneHarness();
  const first = await harness.store.createPasswordUser(input);
  const second = await harness.store.createPasswordUser({ ...input, email: 'second@example.com' });

  assert.equal(first.email, input.email);
  assert.equal(second.email, 'second@example.com');
  assert.deepEqual(harness.counts(), { transactionAttempts: 1, userCreates: 2, identityCreates: 2, userDeletes: 0 });
});

test('standalone registration removes the user if identity creation fails', async () => {
  const identityError = new Error('identity insert failed');
  const harness = standaloneHarness({ identityError });
  await assert.rejects(harness.store.createPasswordUser(input), identityError);
  assert.equal(harness.counts().userDeletes, 1);
});

test('standalone duplicate user insert remains a conflict', async () => {
  const duplicate = Object.assign(new Error('duplicate key'), { code: 11000 });
  const harness = standaloneHarness({ userError: duplicate });
  await assert.rejects(harness.store.createPasswordUser(input), DuplicateEmailError);
});

test('locale update persists only the account preference and maps it into the returned user', async () => {
  const users = {
    findByIdAndUpdate: (id: string, update: unknown, options: unknown) => {
      assert.equal(id, 'owner');
      assert.deepEqual(update, { $set: { locale: 'en-US' } });
      assert.deepEqual(options, { new: true, runValidators: true });
      return { select: () => ({ exec: async () => ({ _id: id, ...input, locale: 'en-US' }) }) };
    },
  } as unknown as Model<UserDocument>;
  const store = new MongoAuthUserStore(users, {} as Model<AuthIdentityDocument>);
  assert.equal((await store.updateLocale('owner', 'en-US'))?.locale, 'en-US');
});
