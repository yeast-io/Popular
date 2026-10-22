import { ResourceSiteError } from './resource-site.errors.js';

/** Validate bounded bencode before sending a site response to a downloader. No payload is logged. */
export function validateTorrentFile(bytes: Uint8Array): void {
  const data = Buffer.from(bytes);
  let offset = 0;
  let hasInfo = false;
  const invalid = (): never => {
    throw new ResourceSiteError('invalidResponse');
  };
  const string = (): Buffer => {
    const start = offset;
    while (offset < data.length && data[offset]! >= 48 && data[offset]! <= 57) offset++;
    if (offset === start || data[offset] !== 58 || (offset - start > 1 && data[start] === 48)) return invalid();
    const size = Number(data.subarray(start, offset).toString('utf8'));
    offset++;
    if (!Number.isSafeInteger(size) || size < 0 || size > data.length - offset) return invalid();
    const value = data.subarray(offset, offset + size);
    offset += size;
    return value;
  };
  const value = (depth: number): void => {
    if (depth > 64 || offset >= data.length) return invalid();
    const token = data[offset];
    if (token === 100 || token === 108) {
      offset++;
      while (data[offset] !== 101) {
        if (offset >= data.length) return invalid();
        if (token === 100) {
          const key = string();
          if (depth === 0 && key.equals(Buffer.from('info'))) {
            if (hasInfo || data[offset] !== 100) return invalid();
            hasInfo = true;
          }
        }
        value(depth + 1);
      }
      offset++;
    } else if (token === 105) {
      const start = ++offset;
      while (offset < data.length && data[offset] !== 101) offset++;
      if (offset >= data.length || !/^(?:0|-?[1-9]\d*)$/.test(data.subarray(start, offset).toString('utf8')))
        return invalid();
      offset++;
    } else {
      string();
    }
  };
  if (data[0] !== 100) return invalid();
  value(0);
  if (!hasInfo || offset !== data.length) return invalid();
}
