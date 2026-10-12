import type { Readable } from 'node:stream';

export interface AvatarObject {
  stream: Readable;
  contentType: string;
}

export interface AvatarStore {
  put(ownerId: string, bytes: Buffer, contentType: string): Promise<string>;
  get(objectKey: string): Promise<AvatarObject>;
  delete(objectKey: string): Promise<void>;
}
