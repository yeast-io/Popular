export type AvatarImage = {
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
};

export function inspectAvatarImage(bytes: Buffer): AvatarImage | undefined {
  return inspectPng(bytes) ?? inspectJpeg(bytes) ?? inspectWebp(bytes);
}

function inspectPng(bytes: Buffer): AvatarImage | undefined {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(signature) ||
    bytes.subarray(12, 16).toString('ascii') !== 'IHDR'
  )
    return undefined;
  return image('image/png', bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

function inspectJpeg(bytes: Buffer): AvatarImage | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return undefined;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return undefined;
    if (isStartOfFrame(marker)) {
      if (segmentLength < 7) return undefined;
      return image('image/jpeg', bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    offset += segmentLength;
  }
  return undefined;
}

function inspectWebp(bytes: Buffer): AvatarImage | undefined {
  if (
    bytes.length < 30 ||
    bytes.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    bytes.subarray(8, 12).toString('ascii') !== 'WEBP'
  )
    return undefined;
  const format = bytes.subarray(12, 16).toString('ascii');
  if (format === 'VP8X') {
    return image('image/webp', readUInt24LE(bytes, 24) + 1, readUInt24LE(bytes, 27) + 1);
  }
  if (format === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return image('image/webp', bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
  }
  if (format === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return image('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return undefined;
}

function isStartOfFrame(marker: number): boolean {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function image(contentType: AvatarImage['contentType'], width: number, height: number): AvatarImage | undefined {
  return width > 0 && height > 0 ? { contentType, width, height } : undefined;
}
