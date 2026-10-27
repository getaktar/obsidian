import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import {
  PROVIDER_PRESETS,
  presetDefaultForcePathStyle,
  presetDefaultRegion,
  type DestinationConfig,
  type ProviderPreset,
  type StorageCredentials,
} from './types.ts';

/**
 * Opening a destination shared from an Aktar app ("Share destination" on
 * Mac, Windows, iOS or Android), format v1:
 *
 *   bytes = [version 0x01] [salt: 16] [nonce: 12] [ciphertext || tag: 16]
 *   link  = "aktar://import#" + base64url(bytes)
 *
 * The key comes from the 12-character transfer code shown on the sending
 * device (PBKDF2-SHA256, 20,000 rounds) and the payload is AES-256-GCM,
 * here the platform's WebCrypto. The same as in the other Aktar apps, and
 * checked against the same test vectors.
 */

export const TRANSFER_LINK_PREFIX = 'aktar://import#';
const VERSION = 1;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const KDF_ITERATIONS = 20_000;
const TRANSFER_DEFAULT_OBJECT_PATH = '{year}/{month}/{uuid}.{ext}';
const AAD = utf8ToBytes('aktar-transfer-v1');
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;
const CLOCK_SKEW_SECONDS = 300;

export type TransferErrorKind = 'notAktar' | 'newerVersion' | 'wrongCode' | 'expired';

export class TransferError extends Error {
  readonly kind: TransferErrorKind;

  constructor(kind: TransferErrorKind) {
    super(kind);
    this.name = 'TransferError';
    this.kind = kind;
  }
}

export interface TransferPayload {
  destination: DestinationConfig;
  credentials: StorageCredentials;
}

/** O, I and L read as 0, 1 and 1; null unless 12 characters of the alphabet remain. */
export function normalizeTransferCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (code.length !== CODE_LENGTH) return null;
  return [...code].every((char) => CODE_ALPHABET.includes(char)) ? code : null;
}

export function formatTransferCodeInput(input: string): string {
  const code = input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

export function looksLikeTransferLink(text: string): boolean {
  return /^aktar:\/\/import\/?#/i.test(text.trim());
}

/** The envelope bytes of a link (or just its base64url part). */
export function parseTransferLink(input: string): Uint8Array {
  const text = input.trim();
  const match = /^aktar:\/\/import\/?#(.*)$/is.exec(text);
  const bytes = base64urlToBytes(match ? match[1] : text);
  if (!bytes || bytes.length < 1 + SALT_LENGTH + NONCE_LENGTH + TAG_LENGTH) throw new TransferError('notAktar');
  if (bytes[0] > VERSION) throw new TransferError('newerVersion');
  if (bytes[0] !== VERSION) throw new TransferError('notAktar');
  return bytes;
}

async function aesGcmOpen(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto.subtle;
  const cryptoKey = await subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt']);
  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: AAD as BufferSource, tagLength: 128 },
    cryptoKey,
    sealed as BufferSource,
  );
  return new Uint8Array(plaintext);
}

/**
 * Decrypts a link with the code the user typed. Throws `wrongCode` for a
 * code that doesn't fit, `notAktar` / `newerVersion` for the link itself
 * and `expired` an hour after the link was made.
 */
export async function openTransfer(link: string, codeInput: string, now: number = Math.floor(Date.now() / 1000)): Promise<TransferPayload> {
  const bytes = parseTransferLink(link);
  const code = normalizeTransferCode(codeInput);
  if (!code) throw new TransferError('wrongCode');
  const salt = bytes.slice(1, 1 + SALT_LENGTH);
  const nonce = bytes.slice(1 + SALT_LENGTH, 1 + SALT_LENGTH + NONCE_LENGTH);
  const sealed = bytes.slice(1 + SALT_LENGTH + NONCE_LENGTH);
  const key = await pbkdf2Async(sha256, utf8ToBytes(code), salt, { c: KDF_ITERATIONS, dkLen: 32 });
  let plaintext: Uint8Array;
  try {
    plaintext = await aesGcmOpen(key, nonce, sealed);
  } catch {
    throw new TransferError('wrongCode');
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new TransferError('notAktar');
  }
  return decodePayload(json, now);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The parts of a transferred destination the plugin uses. Settings that
 * only the apps act on (hooks, routing, image processing, short links) are
 * left out rather than half-honored.
 */
export function decodePayload(json: unknown, now: number = Math.floor(Date.now() / 1000)): TransferPayload {
  if (!isRecord(json)) throw new TransferError('notAktar');
  if (typeof json.v === 'number' && json.v > VERSION) throw new TransferError('newerVersion');
  if (json.v !== VERSION) throw new TransferError('notAktar');
  if (typeof json.expiresAt === 'number' && Number.isFinite(json.expiresAt) && now > json.expiresAt + CLOCK_SKEW_SECONDS) {
    throw new TransferError('expired');
  }
  const d = json.destination;
  const c = json.credentials;
  if (!isRecord(d) || !isRecord(c)) throw new TransferError('notAktar');

  const id = typeof d.id === 'string' && UUID_PATTERN.test(d.id) ? d.id.toUpperCase() : null;
  const name = nonEmptyString(d.name);
  const preset = (PROVIDER_PRESETS as readonly unknown[]).includes(d.preset) ? (d.preset as ProviderPreset) : null;
  const endpoint = nonEmptyString(d.endpoint);
  const bucket = nonEmptyString(d.bucket);
  const publicBaseURL = nonEmptyString(d.publicBaseURL);
  const accessKeyId = nonEmptyString(c.accessKeyId);
  const secretAccessKey = nonEmptyString(c.secretAccessKey);
  if (!id || !name || !preset || !endpoint || !bucket || !publicBaseURL || !accessKeyId || !secretAccessKey) {
    throw new TransferError('notAktar');
  }
  const sessionToken = nonEmptyString(c.sessionToken);
  return {
    destination: {
      id,
      name,
      preset,
      accountID: nonEmptyString(d.accountID),
      endpoint,
      region: nonEmptyString(d.region) ?? presetDefaultRegion(preset),
      bucket,
      publicBaseURL,
      objectPathTemplate: nonEmptyString(d.objectPathTemplate) ?? TRANSFER_DEFAULT_OBJECT_PATH,
      forcePathStyle: typeof d.forcePathStyle === 'boolean' ? d.forcePathStyle : presetDefaultForcePathStyle(preset),
      shortCache: typeof d.shortCache === 'boolean' ? d.shortCache : null,
    },
    credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
  };
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64urlToBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    buffer = (buffer << 6) | BASE64URL_ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes;
}
