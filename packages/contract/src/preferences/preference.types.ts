export interface TasteEntry {
  id: string;
  section: 'explicit' | 'inferred';
  content: string;
  evidenceRefs: string[];
  updatedAt: string;
  protected: boolean;
}
export interface TasteRevision {
  version: number;
  at: string;
  source: string;
  entries: TasteEntry[];
}
export interface TasteProfile {
  version: number;
  autoMaintain: boolean;
  entries: TasteEntry[];
  withdrawn: string[];
  revisions: TasteRevision[];
  generatedAt: string | null;
  generatedFingerprint: string | null;
  updatedAt: string | null;
}
export interface TasteProfileResponse extends TasteProfile {
  text: string;
  ratedCount: number;
  minimumRatings: number;
  marksChanged: boolean;
  task: { status: 'pending' | 'processing' | 'completed' | 'failed'; error: string | null; updatedAt: string } | null;
}
