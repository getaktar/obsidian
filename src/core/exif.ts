/**
 * Removing where a photo was taken before it leaves the device, the
 * default of every Aktar app ("Remove location"). Done on the bytes, without
 * re-encoding, so quality, orientation and the rest of the metadata stay:
 *
 * - JPEG: the GPS directory of the EXIF block is emptied and its values
 *   zeroed, and XMP blocks that carry GPS fields are dropped.
 * - PNG: an `eXIf` chunk is handled the same way as JPEG's EXIF block.
 *
 * Anything else is returned unchanged. Phones hand Obsidian JPEG or PNG
 * when a photo is pasted or attached, so that covers what matters.
 */

const GPS_IFD_TAG = 0x8825;
const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

export interface StripResult {
  data: ArrayBuffer;
  /** Location data was found and removed. */
  removed: boolean;
}

export function stripLocation(input: ArrayBuffer): StripResult {
  const bytes = new Uint8Array(input);
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return stripJPEG(bytes);
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return stripPNG(bytes);
  return { data: input, removed: false };
}

const latin1 = new TextDecoder('latin1');
const ascii = (bytes: Uint8Array, start: number, length: number) =>
  latin1.decode(bytes.subarray(start, Math.min(bytes.length, start + length)));

function stripJPEG(input: Uint8Array): StripResult {
  const bytes = input.slice();
  const keep: [number, number][] = [];
  let removed = false;
  let offset = 2;
  let copiedFrom = 0;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    // Start of scan: the image data follows, no more metadata.
    if (marker === 0xda || marker === 0xd9) break;
    // Fill bytes and markers without a length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const segmentEnd = offset + 2 + length;
    if (length < 2 || segmentEnd > bytes.length) break;
    if (marker === 0xe1) {
      const body = offset + 4;
      if (ascii(bytes, body, 6) === 'Exif\0\0') {
        removed = clearGPS(bytes, body + 6, segmentEnd) || removed;
      } else if (ascii(bytes, body, 29).startsWith('http://ns.adobe.com/xap/1.0/') && /GPS(Latitude|Longitude|Altitude)/.test(ascii(bytes, body, length - 2))) {
        // An XMP packet with a location: dropped whole, it's descriptive metadata only.
        keep.push([copiedFrom, offset]);
        copiedFrom = segmentEnd;
        removed = true;
      }
    }
    offset = segmentEnd;
  }
  if (!removed) return { data: input.buffer as ArrayBuffer, removed: false };
  keep.push([copiedFrom, bytes.length]);
  const total = keep.reduce((sum, [from, to]) => sum + (to - from), 0);
  const output = new Uint8Array(total);
  let position = 0;
  for (const [from, to] of keep) {
    output.set(bytes.subarray(from, to), position);
    position += to - from;
  }
  return { data: output.buffer, removed: true };
}

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function stripPNG(input: Uint8Array): StripResult {
  const bytes = input.slice();
  const view = new DataView(bytes.buffer);
  let removed = false;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    if (dataStart + length + 4 > bytes.length) break;
    if (type === 'eXIf' && clearGPS(bytes, dataStart, dataStart + length)) {
      view.setUint32(dataStart + length, crc32(bytes.subarray(offset + 4, dataStart + length)));
      removed = true;
    }
    if (type === 'IEND') break;
    offset = dataStart + length + 4;
  }
  return removed ? { data: bytes.buffer, removed } : { data: input.buffer as ArrayBuffer, removed: false };
}

/**
 * Empties the GPS directory of the TIFF structure in `bytes[start, end)`:
 * its out-of-line values and entries are zeroed and its entry count set to
 * 0, so readers see a GPS directory with nothing in it. Returns whether
 * there was anything to remove.
 */
function clearGPS(bytes: Uint8Array, start: number, end: number): boolean {
  if (end - start < 8) return false;
  const order = ascii(bytes, start, 2);
  if (order !== 'II' && order !== 'MM') return false;
  const little = order === 'II';
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  const inRange = (at: number, size: number) => at >= start && at + size <= end;

  const ifd0 = start + u32(start + 4);
  if (!inRange(ifd0, 2)) return false;
  const count0 = u16(ifd0);
  let gpsIFD = -1;
  for (let i = 0; i < count0; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (!inRange(entry, 12)) return false;
    if (u16(entry) === GPS_IFD_TAG) gpsIFD = start + u32(entry + 8);
  }
  if (gpsIFD < 0 || !inRange(gpsIFD, 2)) return false;
  const count = u16(gpsIFD);
  if (count === 0) return false;
  for (let i = 0; i < count; i++) {
    const entry = gpsIFD + 2 + i * 12;
    if (!inRange(entry, 12)) break;
    const size = (TYPE_SIZES[u16(entry + 2)] ?? 1) * u32(entry + 4);
    if (size > 4) {
      const valueAt = start + u32(entry + 8);
      if (inRange(valueAt, size)) bytes.fill(0, valueAt, valueAt + size);
    }
    bytes.fill(0, entry, entry + 12);
  }
  view.setUint16(gpsIFD, 0, little);
  return true;
}
