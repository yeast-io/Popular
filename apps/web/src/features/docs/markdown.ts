import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function renderMarkdown(markdown: string, path: string): string {
  const clean = DOMPurify.sanitize(marked.parse(markdown, { async: false, gfm: true }), {
    USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button'], FORBID_ATTR: ['style'],
  });
  const document = new DOMParser().parseFromString(clean, 'text/html');
  const slugs = new Map<string, number>();
  for (const heading of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const base = (heading.textContent ?? '').trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';
    const count = slugs.get(base) ?? 0;
    slugs.set(base, count + 1);
    heading.id = count ? `${base}-${count}` : base;
  }
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = link.getAttribute('href')!;
    if (href.startsWith('#')) continue;
    let resolved: URL;
    try { resolved = new URL(href, `https://docs.invalid/${path}`); }
    catch { link.removeAttribute('href'); continue; }
    if (resolved.origin === 'https://docs.invalid' && /\.md$/i.test(resolved.pathname)) {
      let target: string;
      try { target = decodeURIComponent(resolved.pathname.slice(1)); }
      catch { link.removeAttribute('href'); continue; }
      link.href = `/docs?path=${encodeURIComponent(target)}${resolved.hash}`;
      link.dataset.docPath = target;
    } else if (resolved.protocol === 'https:' || resolved.protocol === 'http:') {
      link.target = '_blank'; link.rel = 'noopener noreferrer';
    }
  }
  return document.body.innerHTML;
}
