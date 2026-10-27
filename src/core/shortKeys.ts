import { StorageError, type ProviderPreset } from './types.ts';

/**
 * The {short} code: 7 characters of 0-9, A-Z and a-z (62^7, about 3.5
 * trillion). Bytes of 248 and up are drawn again, so `value % 62` favors no
 * character. Same as `ShortCode` in the Mac app and the other Aktar apps.
 */
export const SHORT_CODE_LENGTH = 7;
export const SHORT_CODE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const secureRandomBytes = (count: number) => globalThis.crypto.getRandomValues(new Uint8Array(count));

export function makeShortCode(randomBytes: (count: number) => Uint8Array = secureRandomBytes): string {
  let code = '';
  while (code.length < SHORT_CODE_LENGTH) {
    for (const byte of randomBytes(SHORT_CODE_LENGTH)) {
      if (byte < 248 && code.length < SHORT_CODE_LENGTH) code += SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length];
    }
  }
  return code;
}

/**
 * A {short} code that only depends on the file's contents: the same
 * alphabet and length, read from the SHA-256 (hex) the way `makeShortCode`
 * reads random bytes.
 */
export function shortCodeFromHash(sha256Hex: string): string {
  let code = '';
  for (let i = 0; i + 1 < sha256Hex.length && code.length < SHORT_CODE_LENGTH; i += 2) {
    const byte = parseInt(sha256Hex.slice(i, i + 2), 16);
    if (byte < 248) code += SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length];
  }
  return code.padEnd(SHORT_CODE_LENGTH, '0');
}

export function usesShortCode(template: string): boolean {
  return template.includes('{short}');
}

export const MAX_SHORT_KEY_ATTEMPTS = 5;

/** Amazon S3 and Cloudflare R2 honor `If-None-Match: *` on a PUT and on completing a multipart upload. */
export function usesConditionalWrites(preset: ProviderPreset): boolean {
  return preset === 'amazonS3' || preset === 'cloudflareR2';
}

/**
 * Writes a key with a random {short} without replacing a file that already
 * has it, exactly as the other Aktar apps do: a conditional write where the
 * provider supports one, otherwise asking first. A taken key gets a whole
 * new key, and after `MAX_SHORT_KEY_ATTEMPTS` the upload fails rather than
 * replacing anything.
 */
export async function writeShortKey<T>({
  firstKey,
  conditional,
  newKey,
  exists,
  write,
}: {
  firstKey: string;
  conditional: boolean;
  newKey: () => string;
  exists: (key: string) => Promise<boolean>;
  write: (key: string, conditional: boolean) => Promise<T>;
}): Promise<T> {
  let key = firstKey;
  for (let attempt = 1; attempt <= MAX_SHORT_KEY_ATTEMPTS; attempt++) {
    if (attempt > 1) key = newKey();
    if (!conditional) {
      let taken: boolean;
      try {
        taken = await exists(key);
      } catch (error) {
        if (!(error instanceof StorageError && error.detail.kind === 'accessDenied')) throw error;
        taken = false;
      }
      if (taken) continue;
    }
    try {
      return await write(key, conditional);
    } catch (error) {
      if (error instanceof StorageError && error.detail.kind === 'alreadyExists') continue;
      throw error;
    }
  }
  throw new StorageError({ kind: 'noFreeShortKey', attempts: MAX_SHORT_KEY_ATTEMPTS });
}
