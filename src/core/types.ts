import { t } from './i18n.ts';

export const PROVIDER_PRESETS = [
  'cloudflareR2',
  'amazonS3',
  'minIO',
  'backblazeB2',
  'digitalOceanSpaces',
  'customS3',
] as const;

export type ProviderPreset = (typeof PROVIDER_PRESETS)[number];

export function presetDisplayName(preset: ProviderPreset): string {
  switch (preset) {
    case 'cloudflareR2':
      return 'Cloudflare R2';
    case 'amazonS3':
      return 'Amazon S3';
    case 'minIO':
      return 'MinIO';
    case 'backblazeB2':
      return 'Backblaze B2';
    case 'digitalOceanSpaces':
      return 'DigitalOcean Spaces';
    case 'customS3':
      return t('Other S3-compatible');
  }
}

export function presetDefaultRegion(preset: ProviderPreset): string {
  return preset === 'amazonS3' ? 'us-east-1' : 'auto';
}

/** MinIO deployments commonly run without DNS-based virtual-hosted buckets. */
export function presetDefaultForcePathStyle(preset: ProviderPreset): boolean {
  return preset === 'minIO';
}

export function deriveR2Endpoint(accountID: string): string {
  return `https://${accountID.trim()}.r2.cloudflarestorage.com`;
}

/**
 * Where uploads go. The field names match `DestinationConfig` in the Mac,
 * Windows, iOS and Android apps, so a destination imported from any of them means
 * the same thing here. Only what the plugin uses is kept; the keys live in
 * Obsidian's secret storage, never here (see store/credentials.ts).
 */
export interface DestinationConfig {
  id: string;
  name: string;
  preset: ProviderPreset;
  accountID?: string | null;
  endpoint: string;
  region: string;
  bucket: string;
  publicBaseURL: string;
  /** The destination's own path template, as set in the Aktar app. */
  objectPathTemplate: string;
  forcePathStyle: boolean;
  /** Uploads here are sent with a one-minute cache time. */
  shortCache?: boolean | null;
  /**
   * The bucket isn't readable by the public: links are written as usual
   * and the plugin shows them through short-lived signed URLs.
   */
  private?: boolean;
  /** Came from the Aktar app on a desktop; used through it there. */
  fromApp?: boolean;
}

export interface StorageCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | null;
}

/** The outcome of opening a link the way someone it's shared with would. */
export type PublicLinkCheck =
  | { kind: 'reachable' }
  | { kind: 'status'; status: number }
  | { kind: 'noResponse' };

export interface ConnectionResult {
  bucketReachable: boolean;
  writable: boolean;
  publicLink: PublicLinkCheck | null;
}

export interface BucketListing {
  prefix: string;
  folders: string[];
  objects: BucketObject[];
  nextContinuationToken: string | null;
}

export interface BucketObject {
  key: string;
  size: number;
  lastModified: number | null;
}

export function objectName(key: string): string {
  const parts = key.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] ?? '';
}

export type StorageErrorKind =
  | { kind: 'invalidCredentials' }
  | { kind: 'bucketNotFound'; bucket: string }
  | { kind: 'accessDenied' }
  | { kind: 'network'; message: string }
  | { kind: 'credentialsMissing'; destination: string }
  | { kind: 'alreadyExists' }
  | { kind: 'noFreeShortKey'; attempts: number }
  | { kind: 'unknown'; message: string };

export class StorageError extends Error {
  readonly detail: StorageErrorKind;

  constructor(detail: StorageErrorKind) {
    super(describeStorageError(detail));
    this.name = 'StorageError';
    this.detail = detail;
  }

  /** Worth trying again later: the network, not the request, failed. */
  get isTransient(): boolean {
    return this.detail.kind === 'network';
  }
}

function describeStorageError(detail: StorageErrorKind): string {
  switch (detail.kind) {
    case 'invalidCredentials':
      return t('Could not authenticate. Check your Access Key ID and Secret Access Key.');
    case 'bucketNotFound':
      return t('Bucket “{0}” could not be found.', detail.bucket);
    case 'accessDenied':
      return t('Connected, but this key cannot upload files.');
    case 'network':
      return t('No connection to the storage provider. {0}', detail.message);
    case 'credentialsMissing':
      return t('The keys for “{0}” aren’t on this device yet.', detail.destination);
    case 'alreadyExists':
      return t('A file with this name is already in the bucket.');
    case 'noFreeShortKey':
      return t('Couldn’t find an unused short name after {0} tries. Nothing was overwritten.', detail.attempts);
    case 'unknown':
      return detail.message;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
