import type { Locale } from './settings.types';

export interface QueueItem {
  commandId: string;
  resourceId: string;
  source: 'mteam' | 'hdarea';
  title: string | null;
  enqueuedAt: number;
  expiresAt: number;
  reason: 'queued' | 'agent_offline' | 'downloader_unavailable' | 'target_changed' | 'gateway_unavailable' | 'retrying' | 'verifying' | 'executing';
}
export interface QueueSnapshot {
  observedAt: number;
  total: number;
  cursor?: string | null;
  nextCursor: string | null;
  items: QueueItem[];
}
export interface QueueView {
  snapshot: QueueSnapshot | null;
  stale: boolean;
  loading: boolean;
}
export interface QueuePageProps {
  locale: Locale;
}
