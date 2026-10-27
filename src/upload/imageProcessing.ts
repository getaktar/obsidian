import { deletingPathExtension, pathExtension } from '../core/contentType.ts';

/**
 * Making photos smaller before they're uploaded: scaled down to a longest
 * side and/or converted to WebP, the same choices as the Aktar apps'
 * "Image processing". Re-encoding drops all metadata, the location too.
 */

export type ImageFormat = 'original' | 'webp';
export const IMAGE_MAX_EDGES = [0, 3840, 2560, 1920, 1280, 1024] as const;
export const IMAGE_QUALITIES = [90, 80, 65] as const;

export interface ImageSettings {
  format: ImageFormat;
  /** Longest side in pixels; 0 keeps the size. */
  maxEdge: number;
  quality: number;
}

/** What can be decoded and re-encoded without losing something: not animations, vectors or icons. */
const PROCESSABLE = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'avif']);

export function wantsProcessing(filename: string, settings: ImageSettings): boolean {
  if (settings.format === 'original' && settings.maxEdge === 0) return false;
  return PROCESSABLE.has(pathExtension(filename).toLowerCase());
}

/** The size to draw at: the longest side brought down to `maxEdge`, never up. */
export function targetSize(width: number, height: number, maxEdge: number): { width: number; height: number; scaled: boolean } {
  const longest = Math.max(width, height);
  if (!maxEdge || longest <= maxEdge) return { width, height, scaled: false };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scaled: true };
}

/**
 * The type to encode to. WebP when asked; a browser that can't encode it
 * (Safari on iOS) gets JPEG for photos and PNG for PNGs, which may be
 * transparent. Keeping the format re-encodes JPEG and PNG as themselves.
 */
export function outputType(filename: string, settings: ImageSettings, webpSupported: boolean): string {
  const ext = pathExtension(filename).toLowerCase();
  const mayBeTransparent = ext === 'png' || ext === 'webp';
  if (settings.format === 'webp' || ext === 'webp') {
    if (webpSupported) return 'image/webp';
    return mayBeTransparent ? 'image/png' : 'image/jpeg';
  }
  return ext === 'png' ? 'image/png' : 'image/jpeg';
}

export function renamed(filename: string, type: string): string {
  const ext = type === 'image/webp' ? 'webp' : type === 'image/png' ? 'png' : 'jpg';
  return `${deletingPathExtension(filename)}.${ext}`;
}

let webpSupport: Promise<boolean> | null = null;

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality / 100));
}

function supportsWebP(): Promise<boolean> {
  if (!webpSupport) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    webpSupport = encode(canvas, 'image/webp', 80).then((blob) => blob?.type === 'image/webp');
  }
  return webpSupport;
}

/**
 * The processed photo, or null to upload the original: when it can't be
 * decoded here, or the result isn't smaller and nothing was scaled.
 */
export async function processImage(data: ArrayBuffer, filename: string, mime: string, settings: ImageSettings): Promise<{ data: ArrayBuffer; filename: string } | null> {
  if (!wantsProcessing(filename, settings)) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([data], { type: mime }), { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  try {
    const size = targetSize(bitmap.width, bitmap.height, settings.maxEdge);
    const type = outputType(filename, settings, await supportsWebP());
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await encode(canvas, type, settings.quality);
    if (!blob) return null;
    if (!size.scaled && blob.size >= data.byteLength) return null;
    return { data: await blob.arrayBuffer(), filename: renamed(filename, blob.type || type) };
  } finally {
    bitmap.close();
  }
}
