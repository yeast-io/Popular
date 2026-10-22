import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, stat, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPrivateKey } from 'node:crypto';
import { parseEnv } from 'node:util';
import { setupGatewayEnvironment } from './setup-env.service.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gateway-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, envFile: join(root, '.env'), secretsDirectory: join(root, 'secrets') };
}

test('generates independent credentials, private Ed25519 JWK and proxy env without leaking secrets', async (t) => {
  const f = await fixture(t);
  const result = await setupGatewayEnvironment(f);
  const env = parseEnv(await readFile(f.envFile, 'utf8'));
  assert.equal(env.INTERNAL_INBOUND_TOKEN.length, 64);
  assert.equal(env.POPULAR_OUTBOUND_TOKEN, undefined);
  assert.equal(env.TLS_TERMINATION, 'proxy');
  assert.equal(env.TLS_CERT_FILE, undefined);
  assert.equal(env.TLS_KEY_FILE, undefined);
  assert.equal(env.STORAGE_ADAPTER_MODULE, undefined);
  assert.deepEqual(result.requiresConfiguration, []);
  const jwk = JSON.parse(await readFile(env.SIGNING_PRIVATE_KEY_FILE, 'utf8'));
  assert.equal(createPrivateKey({ key: jwk, format: 'jwk' }).asymmetricKeyType, 'ed25519');
  assert.equal((await stat(f.envFile)).mode & 0o777, 0o600);
  assert.equal((await stat(env.SIGNING_PRIVATE_KEY_FILE)).mode & 0o777, 0o600);
  assert.equal((await stat(f.secretsDirectory)).mode & 0o777, 0o700);
  assert.ok(!JSON.stringify(result).includes(jwk.d));
  assert.ok(!JSON.stringify(result).includes(env.INTERNAL_INBOUND_TOKEN));
});

test('rerun preserves credentials, signing identity, unrelated settings/comments and eliminates duplicate assignments', async (t) => {
  const f = await fixture(t);
  await setupGatewayEnvironment(f);
  const initial = parseEnv(await readFile(f.envFile, 'utf8'));
  const jwk = await readFile(initial.SIGNING_PRIVATE_KEY_FILE, 'utf8');
  await writeFile(
    f.envFile,
    (await readFile(f.envFile, 'utf8'))
    + '# custom comment\r\nCUSTOM="keep # value"\r\n'
    + `export INTERNAL_INBOUND_TOKEN='${initial.INTERNAL_INBOUND_TOKEN}'\r\nTLS_CERT_FILE=/old/cert.pem\r\nTLS_KEY_FILE=/old/key.pem\r\n`
  );
  await setupGatewayEnvironment(f);
  const content = await readFile(f.envFile, 'utf8');
  const next = parseEnv(content);
  for (const field of ['INTERNAL_INBOUND_TOKEN', 'SIGNING_PRIVATE_KEY_FILE', 'SIGNING_KEY_ID']) {
    assert.equal(next[field], initial[field]);
  }
  assert.equal(next.CUSTOM, 'keep # value');
  assert.match(content, /# custom comment/);
  assert.equal(content.match(/^INTERNAL_INBOUND_TOKEN=/gm).length, 1);
  assert.equal(await readFile(initial.SIGNING_PRIVATE_KEY_FILE, 'utf8'), jwk);
  await setupGatewayEnvironment(f);
  assert.equal(await readFile(f.envFile, 'utf8'), content);
});

test('existing invalid/missing private keys and conflicting credentials fail without rewriting env or key', async (t) => {
  const f = await fixture(t);
  await setupGatewayEnvironment(f);
  const initial = await readFile(f.envFile, 'utf8');
  const env = parseEnv(initial);
  await writeFile(env.SIGNING_PRIVATE_KEY_FILE, '{"d":"SECRET_PARSE_FRAGMENT"');
  await assert.rejects(setupGatewayEnvironment(f), { code: 'INVALID_SIGNING_KEY' });
  assert.equal(await readFile(f.envFile, 'utf8'), initial);
  await rm(env.SIGNING_PRIVATE_KEY_FILE);
  await assert.rejects(setupGatewayEnvironment(f), { code: 'ENOENT' });
  assert.equal(await readFile(f.envFile, 'utf8'), initial);
});

test('removes obsolete database and outbound configuration and preserves paths with spaces', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.envFile,
    'MONGODB_URI=mongodb://unused\nSTORAGE_ADAPTER_MODULE=/missing.mjs\nPOPULAR_OUTBOUND_TOKEN=obsolete\nPOPULAR_BASE_URL=https://unused/\n'
  );
  const result = await setupGatewayEnvironment({ ...f, secretsDirectory: join(f.root, 'private files') });
  const env = parseEnv(await readFile(f.envFile, 'utf8'));
  for (const field of ['MONGODB_URI', 'STORAGE_ADAPTER_MODULE', 'POPULAR_OUTBOUND_TOKEN', 'POPULAR_BASE_URL'])
    assert.equal(env[field], undefined);
  assert.equal(env.SIGNING_PRIVATE_KEY_FILE, await realpath(join(f.root, 'private files/gateway-signing.jwk.json')));
  assert.deepEqual(result.requiresConfiguration, []);
});

test('refuses env symlinks and concurrent setup locks', async (t) => {
  const f = await fixture(t);
  const target = join(f.root, 'real.env');
  await writeFile(target, 'CUSTOM=unchanged\n');
  await symlink(target, f.envFile);
  await assert.rejects(setupGatewayEnvironment(f), { code: 'REGULAR_FILE_REQUIRED' });
  assert.equal(await readFile(target, 'utf8'), 'CUSTOM=unchanged\n');
  await rm(f.envFile);
  await writeFile(f.envFile + '.setup.lock', '');
  await assert.rejects(setupGatewayEnvironment(f), { code: 'SETUP_ALREADY_RUNNING' });
});

test('CLI has both locales and outputs no secrets even on private-key parsing failure', async (t) => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL('./setup-env.mjs', import.meta.url));
  const args = ['--env-path', f.envFile, '--secrets-dir', f.secretsDirectory];
  for (const locale of ['en-US', 'zh-CN']) {
    const result = spawnSync(process.execPath, [cli, ...args, '--locale', locale], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const env = parseEnv(await readFile(f.envFile, 'utf8'));
    assert.ok(!result.stdout.includes(env.INTERNAL_INBOUND_TOKEN));
    assert.equal(JSON.parse(result.stdout).transport, 'nginx-https-to-http');
  }
  const env = parseEnv(await readFile(f.envFile, 'utf8'));
  await writeFile(env.SIGNING_PRIVATE_KEY_FILE, '{"d":"SECRET_PARSE_FRAGMENT"');
  const failed = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stderr).error.code, 'INVALID_SIGNING_KEY');
  assert.ok(!failed.stderr.includes('SECRET_PARSE_FRAGMENT'));
  assert.ok(!failed.stderr.includes(resolve(f.secretsDirectory)));
});
