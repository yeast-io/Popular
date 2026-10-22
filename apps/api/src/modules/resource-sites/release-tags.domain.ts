/** Stable tag IDs; user-facing labels are resolved by the presentation layer. */
export function releaseTags(...evidence: string[]): string[] {
  const tags = new Set<string>();
  const values = evidence.map((text) => text.normalize('NFKC'));
  for (const value of values) {
    if (/(?<![a-z0-9])(?:2160p|4k)(?![a-z0-9])/i.test(value)) tags.add('4K');
    if (/(?<![a-z0-9])(?:DoVi|DV|Dolby[ ._-]*Vision)(?![a-z0-9])/i.test(value)) tags.add('DoVi');
    const noChinese = values.some((entry) => {
      return /(?:无|無|没有|沒有|不含|暂无|暫無|不带|不帶|非)\s*(?:中(?:文)?(?:字|字幕)|字幕)|(?:中字|中文字幕)\s*(?:待补|待補|未提供)|no[ ._-]*(?:Chinese[ ._-]*)?sub(?:title)?s?/i.test(
        entry
      );
    });
    if (
      !noChinese
      && /中字|中文字幕|中英(?:双|雙)(?:语|語|字|字幕)|[简簡繁](?:体|體)?(?:中(?:文)?)?字幕|[简簡]繁(?:中(?:文)?)?字幕|内[封嵌](?:简|簡|繁|中)|(?<![a-z0-9])(?:CHS|CHT|Chinese[ ._-]*sub(?:title)?s?)(?![a-z0-9])/i.test(
        value
      )
    ) {
      tags.add('chinese-subtitles');
    }
  }
  if (
    values.some((value) => {
      return /(?:无|無|非|不含)\s*(?:DoVi|DV|Dolby[ ._-]*Vision)|no[ ._-]+(?:DoVi|DV|Dolby[ ._-]*Vision)/i.test(value);
    })
  )
    tags.delete('DoVi');
  if (values.some((value) => /(?:非|无|無)\s*4k|not[ ._-]+4k/i.test(value))) tags.delete('4K');
  return ['4K', 'DoVi', 'chinese-subtitles'].filter((tag) => tags.has(tag));
}
