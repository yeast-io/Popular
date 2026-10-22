import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSearch, parseDetail } from './hdarea.parser.js';
import { ResourceSiteError } from '../resource-site.errors.js';
import { HDAreaAdapter } from './hdarea.adapter.js';

const bytes = (value: string) => Buffer.from(value);
const authenticated = '<a href="usercp.php">Account</a>';
// Synthetic fixtures mirror the public Jackett definition; they are not captured live pages.
const row = `<tr><td>x</td><td><table class="torrentname"><tr><td><a href="details.php?id=123" title="Interstellar 2014 1080p">Film</a><a href="https://imdb.com/title/tt0816692">IMDb</a></td></tr></table></td><td>x</td><td>x</td><td>x</td><td>15.5 GiB</td><td>22</td><td>3</td><td>4</td><td>x</td></tr>`;
const searchHtml = `${authenticated}<table class="torrents"><tbody>${row}</tbody></table><a href="torrents.php?page=1">Next</a>`;
test('extracts resource identity, title, binary size, seeders, IMDb and next page', () => {
  assert.deepEqual(parseSearch(bytes(searchHtml), 1), {
    releases: [
      {
        id: '123',
        title: 'Interstellar 2014 1080p',
        sizeBytes: 15.5 * 1024 ** 3,
        seeders: 22,
        imdbId: 'tt0816692',
        resolution: '1080p',
      },
    ],
    nextPage: 2,
  }
  );
});
test('distinguishes explicit empty results, changed pages, login pages and challenges', () => {
  assert.deepEqual(parseSearch(bytes(authenticated + '<p>没有找到</p>'), 1), { releases: [] });
  for (const [html, reason] of [
    [authenticated + '<p>unknown layout</p>', 'invalidResponse'],
    ['<form action="takelogin.php"><input type="password"></form>', 'authentication'],
    ['<title>Just a moment</title>', 'blocked'],
  ]) {
    assert.throws(
      () => parseSearch(bytes(html!), 1),
      (error) => error instanceof ResourceSiteError && error.reason === reason
    );
  }
});
test('detail parsing requires a title but does not depend on a download link', () => {
  assert.deepEqual(parseDetail(bytes(authenticated + '<h1>Interstellar 2014</h1>'), '123'), {
    release: { id: '123', title: 'Interstellar 2014' },
  }
  );
});
test('search encodes keywords and translates one-based pages; IMDb takes priority', async () => {
  const paths: string[] = [];
  const adapter = new HDAreaAdapter('https://hdarea.example/');
  const session = {
    get: async (path: string) => {
      paths.push(path);
      return bytes(authenticated + '没有找到');
    },
  };
  await adapter.search(session, { query: '星际穿越 & 2014', page: 2 });
  let params = new URL(paths[0]!, adapter.baseUrl).searchParams;
  assert.equal(params.get('search'), '星际穿越 & 2014');
  assert.equal(params.get('page'), '1');
  await adapter.search(session, { query: 'ignored', imdbId: 'tt0816692' });
  params = new URL(paths[1]!, adapter.baseUrl).searchParams;
  assert.equal(params.get('search'), 'tt0816692');
});

test('extracts title metadata and absolute publication time from either list time layout', () => {
  const title = 'Movie 2160p WEB-DL H265 DDP5.1 Atmos-BiVerse@ADWeb';
  for (const time of ['<span title="2026-10-05 23:05:14">15 days ago</span>', '2026-10-05<br>23:05:14']) {
    const html
      = authenticated
        + '<table class="torrents"><tbody>'
        + row
          .replace('Interstellar 2014 1080p', title)
          .replace(
            '<td>x</td><td>15.5 GiB</td>',
            `<td>${time}</td><td>15.5 GiB</td>`
          )
          + '</tbody></table>';
    const release = parseSearch(bytes(html), 1).releases[0]!;
    assert.equal(release.publishedAt, '2026-10-05 23:05:14');
    assert.equal(release.medium, 'WEB-DL');
    assert.equal(release.videoCodec, 'H.265');
    assert.equal(release.audioCodec, 'E-AC-3 5.1 Atmos');
    assert.equal(release.releaseGroup, 'BiVerse@ADWeb');
  }
});

test('omits unavailable, relative and impossible publication times rather than inventing a date', () => {
  for (const time of ['unknown', '15 days ago', '2026-02-30 23:05:14', '2026-10-05 25:05:14']) {
    const html
      = authenticated
        + '<table class="torrents"><tbody>'
        + row.replace('<td>x</td><td>15.5 GiB</td>', `<td>${time}</td><td>15.5 GiB</td>`)
        + '</tbody></table>';
    assert.equal(parseSearch(bytes(html), 1).releases[0]!.publishedAt, undefined);
  }
  assert.equal(
    parseDetail(bytes(authenticated + '<h1>Movie 1080p x264-GROUP</h1>'), '123').release.releaseGroup,
    'GROUP'
  );
});

test('extracts tags from resource title, subtitle and explicit images without reading unrelated page content', () => {
  const html
    = authenticated
      + '<p>导航 4K DoVi 中字</p><table class="torrents"><tbody>'
      + row
        .replace('Interstellar 2014 1080p', 'Movie 2160p H265-GROUP')
        .replace(
          '>Film</a>', '>Film</a><br><span>简繁字幕</span><img alt="Dolby Vision"><span title="4K">UHD</span>'
        )
        + '</tbody></table>';
  const result = parseSearch(bytes(html), 1);
  assert.deepEqual(result.releases[0]?.tags, ['4K', 'DoVi', 'chinese-subtitles']);
  assert.equal(
    parseSearch(
      bytes(authenticated + '<p>4K DoVi 中字</p><table class="torrents"><tbody>' + row + '</tbody></table>'),
      1
    ).releases[0]?.tags,
    undefined
  );
});

test('detail tags use heading and metadata rows while ignoring the description', () => {
  const html
    = authenticated
      + '<h1>Movie 2160p H265-GROUP</h1><table><tr><td>副标题</td><td>中英双字 <img title="DoVi"></td></tr><tr><td>描述</td><td>Other version: HDR 4K</td></tr></table>';
  assert.deepEqual(parseDetail(bytes(html), '123').release.tags, ['4K', 'DoVi', 'chinese-subtitles']);
  assert.equal(
    parseDetail(bytes(authenticated + '<h1>Movie 1080p</h1><div id="description">4K DoVi 中字</div>'), '123').release
      .tags,
    undefined
  );
});
