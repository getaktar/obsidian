import { isImageFilename, resolveContentType } from '../core/contentType.ts';
import { stripLocation } from '../core/exif.ts';
import { generateObjectKey, type VaultContext } from '../core/objectKey.ts';
import { makeShortCode, usesConditionalWrites, usesShortCode, writeShortKey } from '../core/shortKeys.ts';
import type { DestinationConfig } from '../core/types.ts';
import type { Storage } from '../storage.ts';

/** Turns a photo into what's uploaded (smaller, another format), or null to keep it. */
export type ImageProcessor = (data: ArrayBuffer, filename: string) => Promise<{ data: ArrayBuffer; filename: string } | null>;

export interface UploadRequest {
  data: ArrayBuffer;
  filename: string;
  destination: DestinationConfig;
  client: Storage;
  /** The path template to use: the plugin's, or the destination's own. */
  template: string;
  vault: VaultContext;
  removeLocation: boolean;
  processImage?: ImageProcessor;
  /**
   * The key only depends on the original file (its bytes and `date`), and
   * what's already under it is reused. Used when moving files that are
   * already in the vault, so a second device doing the same move, or a
   * retried one, lands on the same object and writes the same links.
   */
  stable?: boolean;
  /** The date that goes into {year}, {month}...; now when not given. */
  date?: Date;
  onProgress?: (fraction: number) => void;
}

export interface UploadOutcome {
  key: string;
  url: string;
  /** The name it went up as: different from the file's when it was converted. */
  filename: string;
  byteSize: number;
  /** The file was already in the bucket and wasn't sent again. */
  reused: boolean;
  locationRemoved: boolean;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A template that can give two files the same key. */
function mayCollide(template: string): boolean {
  return !['{short}', '{uuid}', '{random}', '{sha256}'].some((token) => template.includes(token));
}

/** "a.png" taken: "a 2.png", "a 3.png"... as the Mac app names copies in the bucket browser. */
async function availableKey(client: Storage, key: string): Promise<string> {
  if (!(await client.objectExists(key))) return key;
  const slash = key.lastIndexOf('/');
  const dot = key.lastIndexOf('.');
  const hasExtension = dot > slash + 1;
  const base = hasExtension ? key.slice(0, dot) : key;
  const extension = hasExtension ? key.slice(dot) : '';
  for (let n = 2; n <= 1000; n++) {
    const candidate = `${base} ${n}${extension}`;
    if (!(await client.objectExists(candidate))) return candidate;
  }
  throw new Error('No free name');
}

/**
 * One file into the bucket: processed and its location taken out if it's a
 * photo, a key from the template, and the same care the Aktar apps take
 * never to replace someone else's file.
 */
export async function uploadFile(request: UploadRequest): Promise<UploadOutcome> {
  const { client, destination, template } = request;
  // Hashed before anything changes the bytes: processing isn't the same on every device.
  const originalHash = request.stable || template.includes('{sha256}') ? await sha256Hex(request.data) : undefined;
  let data = request.data;
  let filename = request.filename;
  let locationRemoved = false;
  if (isImageFilename(filename)) {
    const processed = request.processImage ? await request.processImage(data, filename) : null;
    if (processed) {
      data = processed.data;
      filename = processed.filename;
      locationRemoved = request.removeLocation;
    } else if (request.removeLocation) {
      const stripped = stripLocation(data);
      data = stripped.data;
      locationRemoved = stripped.removed;
    }
  }
  const contentType = resolveContentType(filename);
  const options = { date: request.date, vault: request.vault, sha256: originalHash };
  const firstKey = request.stable
    ? generateObjectKey(template, filename, options)
    : generateObjectKey(template, filename, { ...options, sha256: template.includes('{sha256}') ? originalHash : undefined });
  const done = (key: string, reused: boolean): UploadOutcome => ({ key, url: client.publicURL(key), filename, byteSize: data.byteLength, reused, locationRemoved });

  if (request.stable) {
    const existing = await client.objectInfo(firstKey);
    // A key made from the file's contents is the same file; a {filename} key may be another one.
    const contentAddressed = /\{(short|sha256)\}/.test(template);
    if (existing && (contentAddressed || existing.size === data.byteLength)) {
      request.onProgress?.(1);
      return done(firstKey, true);
    }
    const key = existing && client.kind === 's3' ? await availableKey(client, firstKey) : firstKey;
    return done(await client.upload(key, data, { contentType, onProgress: request.onProgress }), false);
  }

  // The app never replaces a file: it picks "name 2" itself when the key is taken.
  if (client.kind === 'app') {
    return done(await client.upload(firstKey, data, { contentType, onProgress: request.onProgress }), false);
  }

  if (usesShortCode(template)) {
    return writeShortKey({
      firstKey,
      conditional: usesConditionalWrites(destination.preset),
      newKey: () => generateObjectKey(template, filename, { date: request.date, vault: request.vault, shortCode: makeShortCode }),
      exists: (key) => client.objectExists(key),
      write: async (key, conditional) => done(await client.upload(key, data, { contentType, ifNoneMatch: conditional, onProgress: request.onProgress }), false),
    });
  }

  const key = mayCollide(template) ? await availableKey(client, firstKey) : firstKey;
  return done(await client.upload(key, data, { contentType, onProgress: request.onProgress }), false);
}
