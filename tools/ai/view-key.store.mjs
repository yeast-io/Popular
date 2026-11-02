export function parseViewKeyArguments(args) {
  const [provider, ...rest] = args;
  if (!['deepseek', 'openai', 'claude'].includes(provider)) throw new Error('INVALID_ARGUMENTS');
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!['--email', '--owner-id', '--locale'].includes(flag) || !value || value.startsWith('--') || Object.hasOwn(options, flag))
      throw new Error('INVALID_ARGUMENTS');
    options[flag] = value;
  }
  const email = options['--email']?.trim().toLowerCase();
  const ownerId = options['--owner-id'];
  const locale = options['--locale'] ?? 'zh-CN';
  if (Boolean(email) === Boolean(ownerId) || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    || (ownerId && !/^[a-fA-F0-9]{24}$/.test(ownerId)) || !['zh-CN', 'en-US'].includes(locale))
    throw new Error('INVALID_ARGUMENTS');
  return { provider, email, ownerId, locale };
}

/** Raw collection reads avoid lazy credential migrations and model/index writes. */
export async function readAccountKey({ database, secrets, provider, userFilter }) {
  const users = await database.collection('users').find(userFilter, { projection: { _id: 1 } }).limit(2).toArray();
  if (users.length === 0) throw new Error('USER_NOT_FOUND');
  if (users.length !== 1) throw new Error('AMBIGUOUS_USER');
  const ownerId = users[0]._id;
  const projection = { encryptedApiKey: 1, removed: 1 };
  let record = await database.collection('ai_configs').findOne({ ownerId, provider }, { projection });
  // Any new-format record, including a tombstone, suppresses legacy fallback.
  if (!record && provider === 'openai')
    record = await database.collection('openai_configs').findOne({ ownerId }, { projection });
  if (!record || record.removed || !record.encryptedApiKey) throw new Error('KEY_NOT_FOUND');
  try {
    return secrets.decrypt(record.encryptedApiKey, `movie-hub:integration:${provider}:owner:${ownerId}`);
  } catch {
    throw new Error('DECRYPT_FAILED');
  }
}
