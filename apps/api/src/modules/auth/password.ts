import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH) as Buffer;
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltText, expectedText, extra] = encoded.split('$');
  if (algorithm !== 'scrypt' || !saltText || !expectedText || extra !== undefined) return false;

  try {
    const expected = Buffer.from(expectedText, 'base64url');
    if (expected.length !== KEY_LENGTH) return false;
    const actual = await scrypt(password, Buffer.from(saltText, 'base64url'), expected.length) as Buffer;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
