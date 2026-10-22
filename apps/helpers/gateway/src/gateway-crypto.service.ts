import { CompactEncrypt, CompactSign, compactVerify, importJWK } from 'jose';
import type { DeviceKeys, SigningIdentity } from './gateway.types.js';
import { GatewayError, requireCondition } from './gateway.errors.js';
import { canonical } from './gateway.domain.js';

const bytes = (value: string) => new TextEncoder().encode(value);
export async function validateDeviceKeys(keys: DeviceKeys) {
  requireCondition(keys.signingKey.kty === 'OKP' && keys.signingKey.crv === 'Ed25519', 'INVALID_SIGNING_KEY', 400);
  requireCondition(
    keys.encryptionKey.kty === 'RSA'
    && !!keys.encryptionKey.n
    && Buffer.from(keys.encryptionKey.n, 'base64url').length >= 256
    && Buffer.from(keys.encryptionKey.n, 'base64url').length <= 512,
    'INVALID_ENCRYPTION_KEY',
    400
  );
  // Only public JWK fields pass the runtime schema. Import also rejects malformed public keys.
  try {
    await importJWK(keys.signingKey, 'EdDSA');
    await importJWK(keys.encryptionKey, 'RSA-OAEP-256');
  } catch (cause) {
    throw new GatewayError('INVALID_DEVICE_KEY', 400, { cause });
  }
}
export async function verifyProof(proof: string, expected: string, keys: DeviceKeys) {
  try {
    const result = await compactVerify(proof, await importJWK(keys.signingKey, 'EdDSA'), { algorithms: ['EdDSA'] });
    requireCondition(new TextDecoder().decode(result.payload) === expected, 'INVALID_DEVICE_PROOF', 401);
  } catch (cause) {
    if (cause instanceof GatewayError) throw cause;
    throw new GatewayError('INVALID_DEVICE_PROOF', 401, { cause });
  }
}
export async function signed(identity: SigningIdentity, payload: unknown): Promise<string> {
  return new CompactSign(bytes(canonical(payload)))
    .setProtectedHeader({ alg: 'EdDSA', kid: identity.kid, typ: 'popular-gateway-v1' })
    .sign(identity.privateKey);
}
export async function seal(identity: SigningIdentity, keys: DeviceKeys, payload: unknown): Promise<string> {
  const jwe = await new CompactEncrypt(bytes(canonical(payload)))
    .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM', typ: 'popular-gateway-v1' })
    .encrypt(await importJWK(keys.encryptionKey, 'RSA-OAEP-256'));
  return signed(identity, { protocolVersion: 1, command: '__add_download__', jwe });
}
export async function signingIdentity(kid: string, jwk: Parameters<typeof importJWK>[0]): Promise<SigningIdentity> {
  requireCondition(jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && !!jwk.d, 'INVALID_SERVER_SIGNING_KEY', 500);
  const privateKey = await importJWK(jwk, 'EdDSA');
  requireCondition(!(privateKey instanceof Uint8Array), 'INVALID_SERVER_SIGNING_KEY', 500);
  const publicKey = { kty: 'OKP', crv: 'Ed25519', x: jwk.x!, kid, alg: 'EdDSA', use: 'sig' };
  await importJWK(publicKey, 'EdDSA');
  return { kid, privateKey, publicKey };
}
