import type { BucketListing, BucketObject, ConnectionResult } from './core/types.ts';

export interface UploadOptions {
  contentType: string;
  /** Only write a key that isn't taken; fails with `alreadyExists` otherwise. S3 only. */
  ifNoneMatch?: boolean;
  /**
   * Serve the file to be shown, not downloaded, even when it's HTML. Only
   * for pages the plugin wrote itself (a published note).
   */
  inline?: boolean;
  onProgress?: (fraction: number) => void;
}

/**
 * Where a destination's files are read and written: straight to the bucket
 * with this device's keys (`s3`), or through the Aktar app running on this
 * computer (`app`), which keeps the keys itself. The rest of the plugin
 * doesn't care which.
 */
export interface Storage {
  readonly kind: 's3' | 'app';
  publicURL(key: string): string;
  testConnection(): Promise<ConnectionResult>;
  /**
   * Writes the bytes and returns the key they're under. That's `key`,
   * except through the app, which never replaces a file and may add " 2".
   */
  upload(key: string, data: ArrayBuffer, options: UploadOptions): Promise<string>;
  download(key: string): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
  objectExists(key: string): Promise<boolean>;
  objectInfo(key: string): Promise<{ size: number; lastModified: number | null } | null>;
  list(prefix: string, continuationToken?: string | null): Promise<BucketListing>;
  listAll(prefix: string, onPage?: (count: number) => void): Promise<BucketObject[]>;
  /** A link that works for `seconds` (up to seven days), even for a private bucket. */
  temporaryLink(key: string, seconds: number): Promise<string>;
}
