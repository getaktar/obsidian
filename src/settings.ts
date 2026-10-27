import { DEFAULT_KEY_TEMPLATE } from './core/objectKey.ts';
import type { BackupInterval } from './core/backupPlan.ts';
import { PROVIDER_PRESETS, type DestinationConfig } from './core/types.ts';
import { IMAGE_MAX_EDGES, IMAGE_QUALITIES, type ImageFormat } from './upload/imageProcessing.ts';

export type UploadTrigger = 'images' | 'all' | 'off';
export type LocalCopy = 'trash' | 'keep';

/**
 * Everything in data.json. It's synced along with the vault, so it holds
 * no keys: those are in Obsidian's secret storage on each device.
 */
export interface AktarSettings {
  destinations: DestinationConfig[];
  defaultDestinationId: string | null;
  /** Where uploads go in the bucket; "" uses the destination's own template. */
  keyTemplate: string;
  pasteUpload: UploadTrigger;
  dropUpload: UploadTrigger;
  removeLocation: boolean;
  /** Width given to new image embeds ("600"), or "" for none. */
  imageWidth: string;
  /** Move attachments to the bucket as soon as a note embeds them. */
  autoMove: boolean;
  /** Only attachments in this folder (and below) move on their own; "" is any folder. */
  autoMoveFolder: string;
  /** What happens to a file in the vault once it's in the bucket. */
  localCopy: LocalCopy;
  /** Photos are converted (or kept) and scaled down to `imageMaxEdge` (0 keeps the size). */
  imageFormat: ImageFormat;
  imageMaxEdge: number;
  imageQuality: number;
  /** Images from the bucket are kept on each device for offline use, up to this much. */
  offlineCache: boolean;
  cacheLimitMB: number;
  /** How often the vault is backed up (from devices where it's on); null is never. */
  backupInterval: BackupInterval | null;
  backupKeep: number;
  /** The settings folder (.obsidian) goes into backups too. Other plugins may keep keys in it. */
  backupIncludeConfig: boolean;
  /** The user saw the first-run guide. */
  welcomed: boolean;
}

export const DEFAULT_SETTINGS: AktarSettings = {
  destinations: [],
  defaultDestinationId: null,
  keyTemplate: DEFAULT_KEY_TEMPLATE,
  pasteUpload: 'images',
  dropUpload: 'all',
  removeLocation: true,
  imageWidth: '',
  autoMove: false,
  autoMoveFolder: '',
  localCopy: 'trash',
  imageFormat: 'original',
  imageMaxEdge: 0,
  imageQuality: 80,
  offlineCache: true,
  cacheLimitMB: 500,
  backupInterval: null,
  backupKeep: 7,
  backupIncludeConfig: false,
  welcomed: false,
};

const TRIGGERS: UploadTrigger[] = ['images', 'all', 'off'];

/** Fills in what an older or hand-edited data.json lacks, dropping what doesn't fit. */
export function normalizeSettings(raw: unknown): AktarSettings {
  const data = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<AktarSettings>;
  const destinations = Array.isArray(data.destinations)
    ? data.destinations.filter(
        (d): d is DestinationConfig =>
          typeof d?.id === 'string' &&
          typeof d.name === 'string' &&
          (PROVIDER_PRESETS as readonly string[]).includes(d.preset) &&
          typeof d.endpoint === 'string' &&
          typeof d.bucket === 'string',
      )
    : [];
  const settings: AktarSettings = {
    ...DEFAULT_SETTINGS,
    ...data,
    destinations,
    pasteUpload: TRIGGERS.includes(data.pasteUpload as UploadTrigger) ? (data.pasteUpload as UploadTrigger) : DEFAULT_SETTINGS.pasteUpload,
    dropUpload: TRIGGERS.includes(data.dropUpload as UploadTrigger) ? (data.dropUpload as UploadTrigger) : DEFAULT_SETTINGS.dropUpload,
    localCopy: data.localCopy === 'keep' ? 'keep' : 'trash',
    imageWidth: typeof data.imageWidth === 'string' && /^(\d+(x\d+)?)?$/.test(data.imageWidth) ? data.imageWidth : '',
    keyTemplate: typeof data.keyTemplate === 'string' ? data.keyTemplate : DEFAULT_KEY_TEMPLATE,
    imageFormat: data.imageFormat === 'webp' ? 'webp' : 'original',
    imageMaxEdge: (IMAGE_MAX_EDGES as readonly number[]).includes(data.imageMaxEdge as number) ? (data.imageMaxEdge as number) : 0,
    imageQuality: (IMAGE_QUALITIES as readonly number[]).includes(data.imageQuality as number) ? (data.imageQuality as number) : 80,
    offlineCache: data.offlineCache !== false,
    cacheLimitMB: typeof data.cacheLimitMB === 'number' && data.cacheLimitMB >= 50 ? Math.min(data.cacheLimitMB, 10_000) : 500,
    backupInterval: data.backupInterval === 'daily' || data.backupInterval === 'weekly' ? data.backupInterval : null,
    backupKeep: typeof data.backupKeep === 'number' && data.backupKeep >= 1 ? Math.min(Math.round(data.backupKeep), 100) : 7,
    backupIncludeConfig: data.backupIncludeConfig === true,
  };
  if (!destinations.some((d) => d.id === settings.defaultDestinationId)) {
    settings.defaultDestinationId = destinations[0]?.id ?? null;
  }
  return settings;
}
