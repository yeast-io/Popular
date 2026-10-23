import assert from 'node:assert/strict';
import test from 'node:test';
import { resourceDownloadLimitKind } from './resource-download-limit.schema.js';

test('recognizes confirmed M-Team per-torrent daily limits without generalizing unknown site errors', () => {
  for (const message of ['相同種子當天最多下載10次', '相同种子当天最多下载10次。'])
    assert.equal(resourceDownloadLimitKind('mteam', { code: '429', message }), 'torrent_daily_limit');
  for (const payload of [null, 'rate limit', { message: 'Too many requests' }, { message: '相同種子當天最多下載10次，其他原因' },
    { message: 'API key invalid' }, { message: 123 }])
    assert.equal(resourceDownloadLimitKind('mteam', payload), undefined);
  for (const site of ['hdarea', 'future-site'])
    assert.equal(resourceDownloadLimitKind(site, { message: '相同種子當天最多下載10次' }), undefined);
});
