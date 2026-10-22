import { randomUUID } from 'node:crypto';
import type { Client } from 'minio';
import type { AvatarObject, AvatarStore } from '../../modules/users/user.types.js';

export class MinioAvatarStore implements AvatarStore {
  constructor(private readonly client: Client, private readonly bucket: string) {}

  async put(ownerId: string, bytes: Buffer, contentType: string): Promise<string> {
    const extension = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
    const objectKey = `users/${ownerId}/avatars/${randomUUID()}.${extension}`;
    await this.client.putObject(this.bucket, objectKey, bytes, bytes.length, { 'Content-Type': contentType });
    return objectKey;
  }

  async get(objectKey: string): Promise<AvatarObject> {
    const [stream, stat] = await Promise.all([
      this.client.getObject(this.bucket, objectKey),
      this.client.statObject(this.bucket, objectKey),
    ]);
    const metadata = stat.metaData as Record<string, string | undefined>;
    return { stream, contentType: metadata['content-type'] ?? 'application/octet-stream' };
  }

  async delete(objectKey: string): Promise<void> {
    await this.client.removeObject(this.bucket, objectKey);
  }
}
