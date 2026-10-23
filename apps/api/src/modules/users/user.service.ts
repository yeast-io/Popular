import { aiStep } from '../../infrastructure/logging/ai-trace.js';
import type { AuthUser, UpdateProfileRequest, UpdateUserLocaleRequest } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import { toAuthUser, type AuthService } from '../auth/auth.service.js';
import type { AuthUserStore } from '../auth/auth.types.js';
import type { AvatarObject, AvatarStore } from './user.types.js';
import { inspectAvatarImage } from './avatar-image.js';

export class UserService {
  constructor(
    private readonly auth: AuthService,
    private readonly users: AuthUserStore,
    private readonly avatars: AvatarStore,
    private readonly maxAvatarBytes: number,
    private readonly maxAvatarPixels: number
  ) {}

  async updateLocale(token: string | undefined, input: UpdateUserLocaleRequest): Promise<AuthUser> {
    const ownerId = await aiStep('user.locale.authenticate', () => this.auth.requireOwnerId(token));
    const user = await aiStep('user.locale.persist', () => this.users.updateLocale(ownerId, input.locale));
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    return toAuthUser(user);
  }

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
    const image = inspectAvatarImage(bytes);
    if (!image) throw new AppError(400, 'VALIDATION_ERROR', 'Avatar must be a valid JPEG, PNG, or WebP image');
    if (image.width > Math.floor(this.maxAvatarPixels / image.height)) {
      throw new AppError(400, 'VALIDATION_ERROR', `Avatar must contain no more than ${this.maxAvatarPixels} pixels`);
    }

    const previousUser = await this.users.findById(ownerId);
    if (!previousUser) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    const previousObjectKey = previousUser.avatarObjectKey;
    const objectKey = await this.avatars.put(ownerId, bytes, image.contentType);
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
