export const HDAREA_SELECTORS = {
  authenticated: 'a[href="usercp.php"]',
  rows: 'table.torrents > tbody > tr:has(table.torrentname)',
  title: 'a[href^="details.php?id="]',
};

export const HDAREA_HTTP_TIMEOUT_MS = 20_000;
export const HDAREA_HTTP_INTERVAL_MS = 2_000;
export const HDAREA_HTTP_MAX_BYTES = 8 * 1024 * 1024;
export const HDAREA_HTTP_MAX_PENDING = 20;
