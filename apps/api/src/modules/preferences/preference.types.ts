import type { TasteProfile, TasteProfileResponse } from '@movie-hub/contract';

export interface PreferenceEvidence {
  ref: string;
  text: string;
}

export interface PreferenceChange {
  operation: 'add' | 'replace' | 'remove';
  entryId: string | null;
  section: 'explicit' | 'inferred';
  content: string;
  evidenceRefs: string[];
  reason: string;
}

export interface PreferenceProposal {
  changes: PreferenceChange[];
}

export interface PreferenceJob {
  correlationId?: string;
  id: string;
  ownerId: string;
  kind: 'manual' | 'chat';
  evidence: PreferenceEvidence[];
  fingerprint: string | null;
  attempts: number;
  leaseId: string;
}

/** Application-facing persistence contract; MongoDB models stay in infrastructure. */
export interface PreferenceStore {
  read(ownerId: string): Promise<TasteProfile>;
  save(ownerId: string, expectedVersion: number, profile: TasteProfile, jobId?: string): Promise<boolean>;
  applied(ownerId: string, jobId: string): Promise<boolean>;
  enqueue(
    ownerId: string,
    key: string,
    kind: PreferenceJob['kind'],
    evidence: PreferenceEvidence[],
    fingerprint?: string | null,
  ): Promise<void>;
  latest(ownerId: string): Promise<TasteProfileResponse['task']>;
  claim(leaseId: string): Promise<PreferenceJob | null>;
  finish(job: PreferenceJob, error?: string): Promise<void>;
  owns(job: PreferenceJob): Promise<boolean>;
  renew(job: PreferenceJob): Promise<boolean>;
  cancel(ownerId: string): Promise<void>;
}

export type PreferenceEnricher = (job: PreferenceJob, signal: AbortSignal) => Promise<PreferenceJob>;
