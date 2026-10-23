import { createHash } from 'node:crypto';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import { TORRENT_METADATA_MAX_BYTES } from './torrent-metadata.policy.js';

/** Parse exact bencoded info bytes without re-encoding; hashes use Node/OpenSSL. Bounded untrusted metadata. */
export function torrentMetadataHash(buffer: Buffer): string {
  if (buffer.length > TORRENT_METADATA_MAX_BYTES || buffer[0] !== 100)
    throw new RpcError('INVALID_TORRENT_METADATA', 'not_applied');
  let offset = 0;
  let info: Buffer | undefined;
  let v1 = false;
  let v2 = false;
  const fail = () => {
    throw new RpcError('INVALID_TORRENT_METADATA', 'not_applied');
  };
  const readString = (): Buffer => {
    const colon = buffer.indexOf(58, offset);
    if (colon < offset || colon - offset > 8) return fail();
    const raw = buffer.subarray(offset, colon).toString();
    if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) return fail();
    const length = Number(raw);
    const start = colon + 1;
    offset = start + length;
    if (offset > buffer.length) return fail();
    return buffer.subarray(start, offset);
  };
  const value = (depth: number, isInfo = false): void => {
    if (depth > 64 || offset >= buffer.length) return fail();
    const token = buffer[offset];
    if (token === 105) {
      const end = buffer.indexOf(101, ++offset);
      if (end < 0) return fail();
      if (!/^(?:0|-?[1-9][0-9]*)$/.test(buffer.subarray(offset, end).toString())) return fail();
      offset = end + 1;
      return;
    }
    if (token === 108) {
      offset++;
      while (buffer[offset] !== 101) value(depth + 1);
      offset++;
      return;
    }
    if (token === 100) {
      offset++;
      const seen = new Set<string>();
      while (buffer[offset] !== 101) {
        const key = readString().toString('hex');
        if (seen.has(key)) return fail();
        seen.add(key);
        const name = Buffer.from(key, 'hex').toString();
        const start = offset;
        if (depth === 0 && name === 'info') {
          if (buffer[offset] !== 100) return fail();
          value(depth + 1, true);
          info = buffer.subarray(start, offset);
        } else {
          if (isInfo && name === 'pieces') {
            const pieces = readString();
            if (pieces.length % 20 !== 0) return fail();
            v1 = true;
          } else {
            value(depth + 1);
            if (isInfo && name === 'meta version') v2 = buffer.subarray(start, offset).equals(Buffer.from('i2e'));
          }
        }
      }
      offset++;
      return;
    }
    if (token !== undefined && token >= 48 && token <= 57) {
      readString();
      return;
    }
    fail();
  };
  value(0);
  if (offset !== buffer.length || !info || (!v1 && !v2)) return fail();
  return createHash(v1 ? 'sha1' : 'sha256')
    .update(info)
    .digest('hex');
}
