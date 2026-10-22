import type { ResourceSiteSearch, ResourceSiteRelease } from '@movie-hub/contract';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';

export interface ResourceSiteCredential {
  ownerId: string;
  site: string;
  encryptedCookie: string;
  encryptedPasskey?: string;
  version: string;
  status: 'configured_valid' | 'configured_invalid';
  verifiedAt: Date;
}
export interface ResourceSiteCredentialStore {
  find(ownerId: string, site: string): Promise<ResourceSiteCredential | null>;
  save(input: ResourceSiteCredential): Promise<void>;
  invalidate(ownerId: string, site: string, version: string): Promise<void>;
  delete(ownerId: string, site: string): Promise<void>;
}
export interface ResourceSiteSession {
  get(path: string, signal?: AbortSignal): Promise<Uint8Array>;
}
export interface ResourceSiteAdapter {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  detailsUrl?(id: string): string;
  torrentUrl?(id: string, passkey: string): string;
  verify(session: ResourceSiteSession, signal?: AbortSignal): Promise<void>;
  search(
    session: ResourceSiteSession,
    input: ResourceSiteSearch,
    signal?: AbortSignal,
  ): Promise<{ releases: ResourceSiteRelease[]; nextPage?: number }>;
  detail(session: ResourceSiteSession, id: string, signal?: AbortSignal): Promise<ResourceSiteRelease>;
}
export interface ResourceSiteDiagnostics {
  logger: AiLogger;
  verbose: boolean;
}
export interface ResourceSiteHttpOptions {
  fetch?: typeof fetch;
  intervalMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
}
export interface ResourceSiteHttpLane {
  tail: Promise<void>;
  pending: number;
  nextAt: number;
  blockedUntil: number;
}
