import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectAvatarImage } from './avatar-image.js';

test('reads dimensions from supported avatar formats', () => {
  assert.deepEqual(inspectAvatarImage(pngHeader(3, 2)), { contentType: 'image/png', width: 3, height: 2 });
  assert.deepEqual(inspectAvatarImage(jpegHeader(3, 2)), { contentType: 'image/jpeg', width: 3, height: 2 });
  assert.deepEqual(inspectAvatarImage(webpExtendedHeader(3, 2)), { contentType: 'image/webp', width: 3, height: 2 });
});

test('rejects truncated or zero-dimension image headers', () => {
  assert.equal(inspectAvatarImage(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), undefined);
  assert.equal(inspectAvatarImage(pngHeader(0, 2)), undefined);
});

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpegHeader(width: number, height: number): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff]);
}

function webpExtendedHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  writeUInt24LE(bytes, 24, width - 1);
  writeUInt24LE(bytes, 27, height - 1);
  return bytes;
}

function writeUInt24LE(bytes: Buffer, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}
