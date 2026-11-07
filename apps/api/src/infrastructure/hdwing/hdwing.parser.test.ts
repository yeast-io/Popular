import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAuthenticatedUserId, parseSearch, parseDetail, parseTorrentUrl } from './hdwing.parser.js';
import { ResourceSiteError } from '../../modules/resource-sites/resource-site.errors.js';

const base = 'https://hdwing.org/';
// Synthetic, credential-free fixtures use the HTML structure inspected in logged-in Chrome.
const header = '<div id="site_header"><div class="userinfo"><a href="userdetails.php?id=123">Me</a></div></div>';
const html = (body: string) => Buffer.from(`${header}<div id="site_content">${body}</div>`);
const row = `<tr><td>x</td><td class="t_name"><table class="tbname"><tr><td><h3><a href="details.php?id=42&amp;hit=1" title="Movie 2160p WEB-DL H265-GROUP">Short</a></h3><h4>内封中字</h4></td></tr></table></td><td class="t_time"><span title="2026-11-07 20:14:48">4分</span></td><td class="t_size">12.34 GB</td><td class="t_torrents"><span class="red">0</span></td><td class="t_leech">2</td></tr>`;
const hash = `${Buffer.from('1\n42\n123').toString('base64url')}.test-signature`;
const link = `<a href="download.php?hash=${hash}&amp;uid=123">download</a>`;

test('reads only the current user region and rejects ambiguous or foreign identity', () => {
  assert.equal(parseAuthenticatedUserId(html('<a href="userdetails.php?id=999">Uploader</a>'), base), '123');
  for (const bad of [
    header.replace('id=123', 'id=0'), header.replace('userdetails.php', 'https://evil.example/userdetails.php'),
    header.replace('</div></div>', '<a href="userdetails.php?id=456">Other</a></div></div>'),
    header.replace('id=123', 'id=123&id=456'), '<a href="userdetails.php?id=123">Outside header</a>',
  ]) assert.throws(() => parseAuthenticatedUserId(Buffer.from(bad), base), ResourceSiteError);
});

test('parses the real list layout, including zero seeders, title metadata and exact publication time', () => {
  const result = parseSearch(html(`<table class="torrent_list">${row}</table><div class="page_nav"><a href="?page=1">Next</a></div>`), 1, base);
  assert.equal(result.nextPage, 2);
  assert.equal(result.releases.length, 1);
  assert.equal(result.releases[0]!.id, '42');
  assert.equal(result.releases[0]!.seeders, 0);
  assert.equal(result.releases[0]!.title, 'Movie 2160p WEB-DL H265-GROUP');
  assert.equal(result.releases[0]!.sizeBytes, Math.round(12.34 * 1024 ** 3));
  assert.equal(result.releases[0]!.publishedAt, '2026-11-07 20:14:48');
  assert.deepEqual(result.releases[0]!.tags, ['4K', 'chinese-subtitles']);
  assert.equal(result.releases[0]!.detailsUrl, 'https://hdwing.org/details.php?id=42');
});

test('pagination requires a same-origin numeric next page, not a Next label or comment pagination', () => {
  for (const pagination of ['<a href="?page=1">Next</a>', '<div class="page_nav"><a href="?page=0">Next</a></div>',
    '<div class="page_nav"><a href="https://evil.example/torrents.php?page=1">Next</a></div>'])
    assert.equal(parseSearch(html(`<table class="torrent_list">${row}</table>${pagination}`), 1, base).nextPage, undefined);
  assert.equal(parseSearch(html(`<table class="torrent_list">${row.replace('2026-11-07', '2026-02-30')}</table>`), 1, base).releases[0]!.publishedAt, undefined);
});

test('distinguishes empty results, login, challenge and unexpected layouts', () => {
  assert.deepEqual(parseSearch(html('没有找到'), 1, base), { releases: [] });
  for (const [body, reason] of [['<input type="password">', 'authentication'], ['<title>Just a moment</title>', 'blocked'],
    [header + '<div id="site_content">changed</div>', 'invalidResponse']] as const)
    assert.throws(() => parseSearch(Buffer.from(body), 1, base), (e) => e instanceof ResourceSiteError && e.reason === reason);
});

test('detail metadata excludes the description and unrelated hidden dialog headings', () => {
  const result = parseDetail(html('<div class="m_name"><h2 id="top">Movie 1080p x264-GROUP<span>Free</span></h2><h3>内封中字</h3></div><div id="description">4K DoVi</div><a href="https://imdb.com/title/tt1234567/">IMDb</a>'), '42');
  assert.equal(result.title, 'Movie 1080p x264-GROUP');
  assert.equal(result.description, '内封中字');
  assert.deepEqual(result.tags, ['chinese-subtitles']);
  assert.equal(result.imdbId, 'tt1234567');
});

test('resolves signed URLs only for the requested torrent and verified current account', () => {
  assert.equal(new URL(parseTorrentUrl(html(`<a href="download.php?hash=${hash}">Cookie-only</a>${link}${link}`), '42', '123', base)).searchParams.get('hash'), hash);
  for (const [body, id, uid] of [[link, '43', '123'], [link, '42', '999'],
    [link.replace('download.php', 'https://evil.example/download.php'), '42', '123'],
    [link.replace('&amp;uid=123', '&amp;uid=123&amp;uid=999'), '42', '123'],
    [link.replace(hash, 'invalid.signature'), '42', '123'], ['<a href="download.php?id=42">Cookie-only</a>', '42', '123']] as const)
    assert.throws(() => parseTorrentUrl(html(body), id, uid, base), ResourceSiteError);
});
