export interface StoredUser {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  avatarObjectKey?: string;
}

export interface AuthUserStore {
  createPasswordUser(input: { email: string; displayName: string; passwordHash: string }): Promise<StoredUser>;
  findByEmailWithPassword(email: string): Promise<StoredUser | null>;
  findById(id: string): Promise<StoredUser | null>;
  updateDisplayName(id: string, displayName: string): Promise<StoredUser | null>;
  updateAvatarObjectKey(id: string, avatarObjectKey: string | undefined): Promise<StoredUser | null>;
}

export interface SessionStore {
  create(ownerId: string): Promise<string>;
  getOwnerId(token: string): Promise<string | null>;
  delete(token: string): Promise<void>;
}

export class DuplicateEmailError extends Error {
  constructor() {
    super('Email is already registered');
    this.name = 'DuplicateEmailError';
  }
}
