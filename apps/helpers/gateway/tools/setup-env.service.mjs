import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  createHash,
  randomUUID,
} from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, chmod, unlink, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const gatewayDirectory = fileURLToPath(new URL('../', import.meta.url));
const repositoryDirectory = fileURLToPath(new URL('../../../../', import.meta.url));
const fields = ['INTERNAL_INBOUND_TOKEN'];
const signingPlaceholder = '/run/secrets/gateway-signing.jwk.json';
const failure = (code) => Object.assign(new Error(code), { code });

async function fileText(path, optional = false) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw failure('REGULAR_FILE_REQUIRED');
    return await readFile(path, 'utf8');
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
}
function quote(value) {
  if (/[\r\n\0]/.test(value)) throw failure('INVALID_ENV_VALUE');
  if (/^[a-zA-Z0-9_./:@+-]*$/.test(value)) return value;
  // Node dotenv accepts single-quoted values literally. Refuse ambiguous quoting instead of corrupting paths.
  if (value.includes("'")) throw failure('UNSUPPORTED_ENV_PATH');
  return "'" + value + "'";
}
function updateEnvironment(text, updates) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const seen = new Set();
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match?.[1];
    if (
      [
        'TLS_CERT_FILE',
        'TLS_KEY_FILE',
        'MONGODB_URI',
        'POPULAR_BASE_URL',
        'POPULAR_OUTBOUND_TOKEN',
        'STORAGE_ADAPTER_MODULE',
      ].includes(key)
    )
      continue;
    if (key && Object.hasOwn(updates, key)) {
      if (!seen.has(key)) lines.push(`${key}=${quote(updates[key])}`);
      seen.add(key);
    } else lines.push(line);
  }
  while (lines.at(-1) === '') lines.pop();
  for (const [key, value] of Object.entries(updates)) if (!seen.has(key)) lines.push(`${key}=${quote(value)}`);
  return lines.join(newline) + newline;
}
function validateSigningKey(text) {
  try {
    const jwk = JSON.parse(text);
    const key = createPrivateKey({ key: jwk, format: 'jwk' });
    if (key.asymmetricKeyType !== 'ed25519') throw failure('INVALID_SIGNING_KEY');
    return key;
  } catch {
    throw failure('INVALID_SIGNING_KEY');
  }
}

/** Provision local files only. Never print credentials or access application storage. */
export async function setupGatewayEnvironment(options = {}) {
  const envFile = resolve(options.envFile ?? resolve(gatewayDirectory, '.env'));
  const secretsDirectory = resolve(
    options.secretsDirectory ?? resolve(homedir(), '.config/popular-helper-gateway/secrets')
  );
  await mkdir(dirname(envFile), { recursive: true });
  const lockPath = envFile + '.setup.lock';
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw failure('SETUP_ALREADY_RUNNING');
    throw error;
  }
  let secretsLock;
  let temp;
  try {
    const existing = await fileText(envFile, true);
    const template = await readFile(resolve(gatewayDirectory, '.env.example'), 'utf8');
    const values = parseEnv(existing ?? template);
    const updates = { TLS_TERMINATION: 'proxy' };
    const generated = [];
    const preserved = [];
    for (const key of fields) {
      const value = values[key];
      if (!value || value.startsWith('replace-with-')) {
        updates[key] = randomBytes(48).toString('base64url');
        generated.push(key);
      } else {
        if (value.length < 32 || /[\r\n\0]/.test(value)) throw failure('INVALID_EXISTING_SERVICE_TOKEN');
        updates[key] = value;
        preserved.push(key);
      }
    }
    await mkdir(secretsDirectory, { recursive: true, mode: 0o700 });
    const actualDirectory = await realpath(secretsDirectory);
    const insideRepository = relative(repositoryDirectory, actualDirectory);
    if (!insideRepository || (!insideRepository.startsWith('..') && !isAbsolute(insideRepository))) {
      throw failure('SECRETS_MUST_BE_OUTSIDE_REPOSITORY');
    }
    await chmod(actualDirectory, 0o700);
    try {
      secretsLock = await open(resolve(actualDirectory, '.setup.lock'), 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') throw failure('SETUP_ALREADY_RUNNING');
      throw error;
    }
    let signingPath;
    let signingText;
    if (values.SIGNING_PRIVATE_KEY_FILE && values.SIGNING_PRIVATE_KEY_FILE !== signingPlaceholder) {
      signingPath = resolve(dirname(envFile), values.SIGNING_PRIVATE_KEY_FILE);
      signingText = await fileText(signingPath); // Missing configured key is an error, never a silent rotation.
      preserved.push('SIGNING_PRIVATE_KEY_FILE');
    } else {
      signingPath = resolve(actualDirectory, 'gateway-signing.jwk.json');
      signingText = await fileText(signingPath, true);
      if (signingText === null) {
        signingText = JSON.stringify(generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })) + '\n';
        await writeFile(signingPath, signingText, { flag: 'wx', mode: 0o600 });
        generated.push('SIGNING_PRIVATE_KEY_FILE');
      } else preserved.push('SIGNING_PRIVATE_KEY_FILE');
    }
    const signingKey = validateSigningKey(signingText);
    await chmod(signingPath, 0o600);
    updates.SIGNING_PRIVATE_KEY_FILE = signingPath;
    const keyId
      = existing && values.SIGNING_KEY_ID
        ? values.SIGNING_KEY_ID
        : 'gateway-'
          + createHash('sha256')
            .update(createPublicKey(signingKey).export({ type: 'spki', format: 'der' }))
            .digest('hex')
            .slice(0, 16);
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(keyId)) throw failure('INVALID_SIGNING_KEY_ID');
    updates.SIGNING_KEY_ID = keyId;
    // Do not overwrite an unrelated edit made while generating files.
    if ((await fileText(envFile, true)) !== existing) throw failure('ENV_CHANGED_DURING_SETUP');
    const content = updateEnvironment(existing ?? template, updates);
    temp = envFile + '.' + randomUUID() + '.tmp';
    await writeFile(temp, content, { flag: 'wx', mode: 0o600 });
    await rename(temp, envFile);
    temp = undefined;
    return {
      envFile,
      secretsDirectory: actualDirectory,
      generated,
      preserved,
      transport: 'nginx-https-to-http',
      signingKeyId: keyId,
      requiresConfiguration: [],
    };
  } finally {
    if (temp) await unlink(temp).catch(() => {});
    if (secretsLock) {
      await secretsLock.close();
      await unlink(resolve(secretsDirectory, '.setup.lock'));
    }
    await lock.close();
    await unlink(lockPath);
  }
}
