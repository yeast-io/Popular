import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseViewKeyArguments, readAccountKey } from './view-key.store.mjs';
import { messages } from './view-key.messages.mjs';

const args = process.argv.slice(2);
const localeIndex = args.indexOf('--locale');
const copy = messages[args[localeIndex + 1]] ?? messages['zh-CN'];
let connection;
let stage = 'arguments';
try {
  if (args.length === 1 && args[0] === '--help') {
    console.log(copy.usage);
  } else {
    const input = parseViewKeyArguments(args);
    stage = 'configuration';
    const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
    const { config } = require('dotenv');
    config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });
    const uri = process.env.MONGODB_URI;
    const dbName = process.env.MONGODB_DB_NAME ?? 'movie_hub';
    const secret = process.env.INTEGRATION_SECRET_KEY;
    if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri) || !dbName || !/^[^/\\. "*$<>:|?]+$/.test(dbName) || !secret || secret.length < 32)
      throw new Error('INVALID_CONFIGURATION');
    const { register } = require('tsx/esm/api');
    register();
    const { SecretCrypto } = await import('../../apps/api/src/modules/integrations/secret-crypto.ts');
    const mongoose = require('mongoose');
    stage = 'mongodb.connect';
    connection = mongoose.createConnection(uri, { dbName, serverSelectionTimeoutMS: 10_000, autoIndex: false, autoCreate: false });
    await connection.asPromise();
    stage = 'credentials.read';
    const key = await readAccountKey({
      database: connection.db, secrets: new SecretCrypto(secret), provider: input.provider,
      userFilter: input.email ? { email: input.email } : { _id: new mongoose.Types.ObjectId(input.ownerId) },
    });
    // Intentional plaintext output for this local recovery command; never put it in diagnostic logs.
    process.stdout.write(`${key}\n`);
  }
} catch (error) {
  console.error(`[${stage}] ${copy[error.message] ?? copy.FAILED}`);
  process.exitCode = 1;
} finally {
  if (connection) await connection.close().catch(() => {
    process.exitCode = 1;
  });
}
