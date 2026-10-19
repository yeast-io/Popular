import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export class SecretCrypto {
  private readonly key: Buffer;

  constructor(
    keyMaterial: string
  ) {
    this.key = createHash('sha256').update('movie-hub:integration-secrets:v1\0').update(keyMaterial).digest();
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(value: string, context: string): string {
    const [version, encodedIv, encodedTag, encodedCiphertext] = value.split('.');
    if (version !== 'v1' || !encodedIv || !encodedTag || !encodedCiphertext)
      throw new Error('Unsupported encrypted secret');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(encodedIv, 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encodedCiphertext, 'base64url')), decipher.final()]).toString(
      'utf8',
    );
  }
}
