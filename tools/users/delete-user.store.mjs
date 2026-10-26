import { createHmac } from 'node:crypto';
import { userOwnedCollections } from './delete-user.policy.mjs';

export function parseDeleteUserArguments(args) {
  const positional = args.filter((arg) => arg !== '--dry-run');
  const email = positional[0]?.trim().toLowerCase();
  if (positional.length !== 1 || !email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('INVALID_ARGUMENTS');
  }
  return { email, dryRun: args.includes('--dry-run') };
}

export async function deleteUserData({ database, redis, avatars, prefix, pepper, email, dryRun, report }) {
  report('user.lookup', { outcome: 'started' });
  const user = await database.collection('users').findOne({ email }, { projection: { _id: 1, avatarObjectKey: 1 } });
  const ownerId = user ? String(user._id) : null;
  if (user?.avatarObjectKey && !user.avatarObjectKey.startsWith(`users/${ownerId}/avatars/`)) throw new Error('INVALID_AVATAR');
  const digest = createHmac('sha256', pepper).update(`email\0${email}`).digest('hex');
  const pendingKey = `${prefix}registration:email:pending:${digest}`;
  const result = { userFound: Boolean(user), userDeleted: 0, sessions: 0, pendingRegistration: 0, avatar: 0, collections: {} };
  // Delete the user last: partial failures retain the ID needed for an idempotent retry.
  // Callers must stop the API/workers to prevent concurrent registrations and writes.
  if (user) {
    report('sessions.cleanup', { outcome: 'started' });
    let cursor = '0';
    const seen = new Set();
    const pattern = `${prefix.replace(/[\\*?[\]]/g, '\\$&')}session:*`;
    do {
      const page = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = page[0];
      for (const key of page[1]) {
        if (seen.has(key)) continue;
        seen.add(key);
        if (dryRun) {
          if (await redis.get(key) === ownerId) result.sessions++;
        } else {
          // Compare-and-delete protects other users even if a key changes during SCAN.
          result.sessions += Number(await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", 1, key, ownerId));
        }
      }
    } while (cursor !== '0');
    report('sessions', { count: result.sessions });
    const filter = { ownerId: { $in: [user._id, ownerId] } };
    for (const name of userOwnedCollections) {
      const collection = database.collection(name);
      report('collection.cleanup', { outcome: 'started', collection: name });
      result.collections[name] = dryRun ? await collection.countDocuments(filter) : (await collection.deleteMany(filter)).deletedCount;
      report('collection', { collection: name, count: result.collections[name] });
    }
    if (user.avatarObjectKey) {
      report('avatar.cleanup', { outcome: 'started' });
      if (!dryRun) await avatars.delete(user.avatarObjectKey);
      result.avatar = 1;
      report('avatar', { count: 1 });
    }
  }
  report('pending-registration.cleanup', { outcome: 'started' });
  result.pendingRegistration = dryRun ? await redis.exists(pendingKey) : await redis.del(pendingKey);
  report('pending-registration', { count: result.pendingRegistration });
  if (user) {
    report('user.delete', { outcome: 'started' });
    result.userDeleted = dryRun ? 0 : (await database.collection('users').deleteOne({ _id: user._id, email })).deletedCount;
    report('user', { count: result.userDeleted });
  }
  return result;
}
