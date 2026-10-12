import type { AuthUser, UpdateProfileRequest } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import { toAuthUser, type AuthService } from '../auth/auth.service.js';
import type { AuthUserStore } from '../auth/auth.types.js';
import type { AvatarObject, AvatarStore } from './user.types.js';

export class UserService {
  constructor(
    private readonly auth: AuthService,
    private readonly users: AuthUserStore,
    private readonly avatars: AvatarStore,
    private readonly maxAvatarBytes: number,
  ) {}

  async updateProfile(token: string | undefined, input: UpdateProfileRequest): Promise<AuthUser> {
    const ownerId = await this.auth.requireOwnerId(token);
    const displayName = input.displayName.trim();
    if (!displayName) throw new AppError(400, 'VALIDATION_ERROR', 'Display name cannot be blank');
    const user = await this.users.updateDisplayName(ownerId, displayName);
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    return toAuthUser(user);
  }

  async uploadAvatar(token: string | undefined, bytes: Buffer): Promise<AuthUser> {
    const ownerId = await this.auth.requireOwnerId(token);
    if (bytes.length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'Avatar file is empty');
    if (bytes.length > this.maxAvatarBytes) {
      throw new AppError(413, 'BAD_REQUEST', `Avatar must be no larger than ${this.maxAvatarBytes} bytes`);
    }
    const contentType = detectImageType(bytes);
    if (!contentType) throw new AppError(400, 'VALIDATION_ERROR', 'Avatar must be a JPEG, PNG, or WebP image');

    const previousUser = await this.users.findById(ownerId);
    if (!previousUser) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    const previousObjectKey = previousUser.avatarObjectKey;
    const objectKey = await this.avatars.put(ownerId, bytes, contentType);
    let user;
    try {
      user = await this.users.updateAvatarObjectKey(ownerId, objectKey);
    } catch (error) {
      await this.avatars.delete(objectKey).catch(() => undefined);
      throw error;
    }
    if (!user) {
      await this.avatars.delete(objectKey).catch(() => undefined);
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }
    if (previousObjectKey) {
      await this.avatars.delete(previousObjectKey).catch(() => undefined);
    }
    return toAuthUser(user);
  }

  async getAvatar(token: string | undefined): Promise<AvatarObject> {
    const ownerId = await this.auth.requireOwnerId(token);
    const user = await this.users.findById(ownerId);
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    if (!user.avatarObjectKey) throw new AppError(404, 'NOT_FOUND', 'Avatar not found');
    return this.avatars.get(user.avatarObjectKey);
  }

  async deleteAvatar(token: string | undefined): Promise<void> {
    const ownerId = await this.auth.requireOwnerId(token);
    const existing = await this.users.findById(ownerId);
    if (!existing) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    if (!existing.avatarObjectKey) return;
    const objectKey = existing.avatarObjectKey;
    const user = await this.users.updateAvatarObjectKey(ownerId, undefined);
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    await this.avatars.delete(objectKey).catch(() => undefined);
  }
}

function detectImageType(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}
