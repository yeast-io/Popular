import type { ResourceDownloadLimit } from './resource-download-limit.types.js';

/** Site adapters recognize confirmed responses only; HTTP 429 alone is not a per-torrent daily limit. */
export function resourceDownloadLimitKind(source: string, payload: unknown): ResourceDownloadLimit['kind'] | undefined {
  if (!payload || typeof payload !== 'object' || !('message' in payload) || typeof payload.message !== 'string') return;
  if (source === 'mteam') {
    const message = payload.message.trim().replaceAll('種', '种').replaceAll('當', '当').replaceAll('下載', '下载');
    if (/^相同种子当天最多下载\d+次[。.!！]?$/.test(message)) return 'torrent_daily_limit';
  }
  // Add confirmed HDArea / future site response mappings here without changing scheduling or clients.
  return;
}
